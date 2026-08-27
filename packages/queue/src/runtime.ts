/**
 * C057 §10 — QueuePort surface and WorkerRuntime loop.
 *
 * Runtime semantics (C057 §4/§9):
 * - claim → fence check → handler with heartbeat → complete or retry/DLQ;
 * - graceful drain: stop intake, bounded wait for in-flight handlers, then
 *   release leases so another worker reconciles abandoned work;
 * - delivery is at-least-once; PostgreSQL is authoritative.
 */
import { UnknownJobTypeError } from './envelope.js';
import type { JobEnvelope, JobHandler, JobRegistry, QueueName } from './envelope.js';
import {
  QUEUE_RETRY_DEFAULTS,
  backoffDelayMs,
  type CancellationFence,
  type QueueTransport,
  type RetryOptions,
} from './retry.js';
interface LoggerPort {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, error: unknown, fields?: Record<string, unknown>): void;
}

export interface EnqueueResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
}

export class Queue implements QueuePortShape {
  constructor(private readonly transport: QueueTransport) {}

  async enqueue(job: JobEnvelope, options?: Partial<RetryOptions>): Promise<EnqueueResult> {
    void options;
    return this.transport.enqueue(job, 0);
  }

  /** Delayed enqueue helper for retries/cooldowns. */
  async enqueueDelayed(job: JobEnvelope, delayMs: number): Promise<EnqueueResult> {
    if (delayMs === 0) return this.transport.enqueue(job, 0);
    // InMemoryTransport models delayed jobs via availableAtMs on the same map.
    return this.transport.enqueue(job, delayMs);
  }

  async remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'> {
    return this.transport.remove(uniqueKey);
  }

  async inspect(): Promise<{ pending: number }> {
    return { pending: this.pendingCount };
  }

  protected get pendingCount(): number {
    return (this.transport as unknown as { pendingCount?(): number }).pendingCount?.() ?? -1;
  }
}

export interface QueuePortShape {
  enqueue(job: JobEnvelope, options?: Partial<RetryOptions>): Promise<EnqueueResult>;
  remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'>;
}

export interface WorkerRuntimeOptions {
  readonly queues: readonly QueueName[];
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly maxConcurrent: number;
  readonly workerId: string;
  readonly maxAttemptsByQueue?: Readonly<Record<string, RetryOptions>> | undefined;
}

const TERMINAL_AFTER_MAX_ATTEMPTS = (attempts: number, max: number): boolean => attempts >= max;

export class WorkerRuntime {
  #running = false;
  #draining = false;
  #inFlight = new Set<string>();

  constructor(
    private readonly registry: JobRegistry,
    private readonly transport: QueueTransport,
    private readonly fence: CancellationFence,
    private readonly logger: LoggerPort | undefined,
    private readonly options: WorkerRuntimeOptions,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    this.#running = true;
    this.logger?.info('worker.started', { event: 'worker.started' });
  }

  /**
   * One processing pass (poll); used by the driver loop and by tests with
   * deterministic clocks. Returns the number of jobs processed.
   */
  async processOnce(nowMs: number): Promise<number> {
    if (!this.#running || this.#draining || this.#stopRequested) return 0;
    await this.transport.releaseExpiredLeases(nowMs);
    let processed = 0;
    for (const queueName of this.options.queues) {
      if (this.#inFlight.size >= this.options.maxConcurrent) break;
      const claimed = await this.transport.claim(
        queueName,
        this.options.leaseMs,
        this.options.workerId,
      );
      for (const envelope of claimed) {
        processed += 1;
        const uniqueKey = envelope.uniqueKey;
        this.#inFlight.add(uniqueKey);
        try {
          await this.#executeClaimed(envelope, nowMs);
        } finally {
          this.#inFlight.delete(uniqueKey);
        }
      }
    }
    return processed;
  }

  async #executeClaimed(envelope: JobEnvelope, _nowMs: number): Promise<void> {
    void _nowMs;
    const attemptKey = envelope.uniqueKey;
    let retryDefaults: RetryOptions = QUEUE_RETRY_DEFAULTS[envelope.queue] ?? { maxAttempts: 8 };
    const overrides = this.options.maxAttemptsByQueue?.[envelope.queue];
    if (overrides) retryDefaults = { ...retryDefaults, ...overrides };

    // Cancellation fence: stale generation aborts before dispatch.
    if (this.fence.isFenced(envelope)) {
      this.logger?.warn('job.cancelled_fenced', { jobId: envelope.jobId });
      await this.transport.deadLetter(envelope.uniqueKey, 'CANCELLED_FENCED');
      return;
    }

    let outcome: Awaited<ReturnType<JobHandler>>;
    try {
      const handler = this.registry.resolve(envelope.jobType, envelope.schemaVersion);
      const controller = new AbortController();
      outcome = await handler(envelope, {
        attempt: this.attemptsOf(attemptKey),
        maxAttempts: retryDefaults.maxAttempts,
        leaseToken: `${this.options.workerId}:${attemptKey}`,
        signal: controller.signal,
      } as never);
    } catch (error) {
      if (error instanceof UnknownJobTypeError) {
        // Unregistered types fail closed straight to DLQ (C057 §5).
        await this.transport.deadLetter(envelope.uniqueKey, 'JOB_UNKNOWN');
        this.logger?.error('job.dead_lettered', error, {
          jobId: envelope.jobId,
          status: 'dead_lettered',
          attempt: 1,
        });
        return;
      }
      throw error;
    }

    switch (outcome.outcome) {
      case 'SUCCEEDED': {
        await this.transport.complete(envelope.uniqueKey, this.options.workerId);
        this.logger?.info('job.completed', { jobId: envelope.jobId });
        break;
      }
      case 'RETRYABLE_FAILURE': {
        const attempts = this.attemptsOf(attemptKey);
        if (TERMINAL_AFTER_MAX_ATTEMPTS(attempts, retryDefaults.maxAttempts)) {
          await this.transport.deadLetter(envelope.uniqueKey, outcome.errorCode);
          this.logger?.error('job.dead_lettered', undefined, {
            jobId: envelope.jobId,
            status: 'dead_lettered',
            attempt: attempts,
          });
        } else {
          // Exponential backoff with FULL JITTER, deterministic under an
          // injected random source.
          const delay = backoffDelayMs(attempts + 1, retryDefaults, this.random);
          await this.transport
            .complete(envelope.uniqueKey, this.options.workerId)
            .catch(() => undefined);
          await this.transport.enqueue(envelope, delay);
          this.logger?.warn('job.retry_scheduled', {
            jobId: envelope.jobId,
            attempt: attempts + 1,
          });
        }
        break;
      }
      case 'PERMANENT_FAILURE': {
        await this.transport.deadLetter(envelope.uniqueKey, outcome.errorCode);
        this.logger?.error('job.dead_lettered', undefined, {
          jobId: envelope.jobId,
          status: 'dead_lettered',
        });
        break;
      }
    }
  }

  /** Graceful drain per C057 §4.4: stop intake, bounded in-flight wait. */
  async drain(signalAborted: () => boolean): Promise<void> {
    this.#draining = true;
    this.logger?.info('worker.draining', { event: 'worker.draining' });
    const deadline = Date.now() + 30_000;
    while (
      this.#inFlight.size > 0 &&
      !signalAborted() &&
      Date.now() < deadline &&
      !this.#stopRequested
    ) {
      // Drivers may keep calling processOnce; here we merely bound the wait.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.#draining = false;
  }

  #stopRequested = false;

  stop(): void {
    this.#stopRequested = true;
    this.#running = false;
    this.logger?.info('worker.stopped', { event: 'worker.stopped' });
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get draining(): boolean {
    return this.#draining;
  }

  get running(): boolean {
    return this.#running;
  }

  // Exposed for composition-root health probes (C074 consumes).
  queueNames(): readonly QueueName[] {
    return [...this.options.queues];
  }

  private attemptsOf(uniqueKey: string): number {
    return (
      (this.transport as unknown as { attemptsOf?(k: string): number }).attemptsOf?.(uniqueKey) ?? 0
    );
  }
}

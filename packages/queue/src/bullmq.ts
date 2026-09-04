/**
 * Production Redis delivery using BullMQ.
 *
 * PostgreSQL remains the source of truth for workflow state and the outbox is
 * the producer. BullMQ owns only delivery, locking, retry backoff, and worker
 * concurrency; stable envelope job IDs make relay retries idempotent.
 */
import {
  Queue as BullQueue,
  Worker as BullWorker,
  UnrecoverableError,
  type ConnectionOptions,
  type Job,
} from 'bullmq';
import type { JobEnvelope, JobRegistry, QueueName } from './envelope.js';
import { QUEUE_RETRY_DEFAULTS, type RetryOptions } from './retry.js';
import type { QueuePortShape, EnqueueResult } from './runtime.js';

export interface BullMqQueueOptions {
  readonly connection: ConnectionOptions;
  readonly prefix?: string | undefined;
  readonly retryByQueue?: Readonly<Record<string, RetryOptions>> | undefined;
}

/** Producer-facing queue port used by the outbox relay and application jobs. */
export class BullMqQueue implements QueuePortShape {
  private readonly queues = new Map<QueueName, BullQueue<JobEnvelope>>();
  private readonly options: BullMqQueueOptions;

  constructor(options: BullMqQueueOptions) {
    this.options = options;
  }

  private queue(name: QueueName): BullQueue<JobEnvelope> {
    const existing = this.queues.get(name);
    if (existing !== undefined) return existing;
    const created = new BullQueue<JobEnvelope>(name, {
      connection: this.options.connection,
      prefix: this.options.prefix ?? 'devguard',
    });
    this.queues.set(name, created);
    return created;
  }

  async enqueue(
    job: JobEnvelope,
    optionsOrDelay?: Partial<RetryOptions> | number,
  ): Promise<EnqueueResult> {
    const delay = typeof optionsOrDelay === 'number' ? optionsOrDelay : 0;
    const options = typeof optionsOrDelay === 'number' ? undefined : optionsOrDelay;
    const retry = {
      ...(QUEUE_RETRY_DEFAULTS[job.queue] ?? { maxAttempts: 8 }),
      ...this.options.retryByQueue?.[job.queue],
      ...options,
    };
    try {
      const target = this.queue(job.queue);
      if ((await target.getJob(job.uniqueKey)) !== undefined) {
        return { accepted: false, duplicate: true };
      }
      await target.add(job.jobType, job, {
        jobId: job.uniqueKey,
        delay,
        attempts: retry.maxAttempts,
        backoff: { type: 'exponential', delay: (retry.backoffBaseSeconds ?? 1) * 1_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 100_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
      });
      return { accepted: true, duplicate: false };
    } catch (error) {
      if (error instanceof Error && /jobId.*exist|already exists/i.test(error.message)) {
        return { accepted: false, duplicate: true };
      }
      throw error;
    }
  }

  async remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'> {
    for (const queue of this.queues.values()) {
      const job = await queue.getJob(uniqueKey);
      if (job === undefined) continue;
      const state = await job.getState();
      if (state === 'active') return 'active';
      await job.remove();
      return 'removed';
    }
    return 'missing';
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}

export interface BullMqWorkerRuntimeOptions {
  readonly connection: ConnectionOptions;
  readonly prefix?: string | undefined;
  readonly queues: readonly QueueName[];
  readonly registry: JobRegistry;
  readonly concurrency?: number | undefined;
  readonly logger?: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
    error(event: string, error: unknown, fields?: Record<string, unknown>): void;
  } | undefined;
}

/** BullMQ push workers with typed registry dispatch and retry classification. */
export class BullMqWorkerRuntime {
  private readonly workers: BullWorker<JobEnvelope>[] = [];
  private running = false;

  constructor(private readonly options: BullMqWorkerRuntimeOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const queueName of this.options.queues) {
      const worker = new BullWorker<JobEnvelope>(
        queueName,
        async (job) => this.process(job),
        {
          connection: this.options.connection,
          prefix: this.options.prefix ?? 'devguard',
          concurrency: this.options.concurrency ?? 10,
        },
      );
      worker.on('failed', (job, error) => {
        this.options.logger?.error('job.failed', error, {
          jobId: job?.id,
          queue: queueName,
          attemptsMade: job?.attemptsMade,
        });
      });
      this.workers.push(worker);
    }
    this.options.logger?.info('bullmq.workers.started', { queues: this.options.queues });
  }

  async close(): Promise<void> {
    this.running = false;
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers.length = 0;
  }

  stop(): void {
    this.running = false;
  }

  async drain(_signalAborted: () => boolean): Promise<void> {
    await this.close();
  }

  async processOnce(_nowMs: number): Promise<number> {
    return 0;
  }

  get pollIntervalMs(): number {
    return 0;
  }

  get inFlightCount(): number {
    return 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async process(job: Job<JobEnvelope>): Promise<void> {
    const envelope = job.data;
    const handler = this.options.registry.resolve(envelope.jobType, envelope.schemaVersion);
    const controller = new AbortController();
    const retry = QUEUE_RETRY_DEFAULTS[envelope.queue] ?? { maxAttempts: 8 };
    const result = await handler(envelope, {
      attempt: job.attemptsMade + 1,
      maxAttempts: retry.maxAttempts,
      leaseToken: `bullmq:${String(job.id)}:${job.attemptsMade + 1}`,
      signal: controller.signal,
    });
    if (result.outcome === 'PERMANENT_FAILURE') {
      throw new UnrecoverableError(`${result.errorCode}:${result.detail ?? ''}`);
    }
    if (result.outcome === 'RETRYABLE_FAILURE') {
      throw new Error(`${result.errorCode}:${result.detail ?? ''}`);
    }
  }
}

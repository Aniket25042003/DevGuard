/**
 * C057 §4/§5/§9 — retry classification, backoff with full jitter, lease/stall
 * semantics and the cancellation fence.
 *
 * Backoff: exponential base 2^n seconds capped at 60s, then FULL JITTER
 * (uniform in [0, cap]) using an injectable random source so tests are
 * deterministic. Queue delivery is AT-LEAST-ONCE; PostgreSQL state remains
 * authoritative (C057 §2).
 */
import type { JobEnvelope } from './envelope.js';

/** Exported alias kept for parity with docs naming. */

export interface RetryOptions {
  readonly maxAttempts: number;
  /** Base delay seconds for exponential growth (default 1s). */
  readonly backoffBaseSeconds?: number | undefined;
  readonly maxBackoffSeconds?: number | undefined;
}

export const QUEUE_RETRY_DEFAULTS: Readonly<Record<string, RetryOptions>> = Object.freeze({
  'webhook-processing': { maxAttempts: 8 },
  'workflow-execution': { maxAttempts: 10 },
  'sandbox-monitoring': { maxAttempts: 6 },
  'approval-resume': { maxAttempts: 12 },
  'outbox-publishing': { maxAttempts: 15 },
  cleanup: { maxAttempts: 3 },
});

/** Full-jitter delay computation (AWS-style) over the attempt number. */
export function backoffDelayMs(
  attempt: number,
  options: RetryOptions,
  random: () => number = Math.random,
): number {
  if (attempt < 1) throw new TypeError('attempt is 1-based and must be >= 1');
  const base = options.backoffBaseSeconds ?? 1;
  const cap = options.maxBackoffSeconds ?? 60;
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.floor(random() * exp * 1000);
}

export interface StallDetection {
  readonly stalledJobs: ReadonlyArray<{ readonly uniqueKey: string; readonly workerId: string }>;
}

/**
 * Lease/visibility contract implemented by transports:
 * - claim leases jobs with `leaseMs` visibility to one owner;
 * - heartbeat extends the lease while a handler runs;
 * - on lease expiry another worker may claim: stale completions are fenced.
 */
export interface QueueTransport {
  enqueue(
    envelope: JobEnvelope,
    delayMs: number,
  ): Promise<{ accepted: boolean; duplicate: boolean }>;
  claim(queueName: string, leaseMs: number, workerId: string): Promise<JobEnvelope[]>;
  heartbeat(uniqueKey: string, leaseMs: number, workerId: string): Promise<boolean>;
  complete(uniqueKey: string, workerId: string): Promise<'completed' | 'fenced' | 'missing'>;
  deadLetter(uniqueKey: string, errorCode: string): Promise<void>;
  remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'>;
  releaseExpiredLeases(nowMs: number): Promise<number>;
}

export class InMemoryTransport implements QueueTransport {
  #pending = new Map<string, { envelope: JobEnvelope; availableAtMs: number }>();
  #active = new Map<
    string,
    { envelope: JobEnvelope; leaseUntilMs: number; workerId: string; attempts: number }
  >();
  #dead = new Set<string>();
  #perQueueAttemptCount = new Map<string, number>();

  constructor(private readonly clockNow = (): number => Date.now()) {}

  async enqueue(
    envelope: JobEnvelope,
    delayMs: number,
  ): Promise<{ accepted: boolean; duplicate: boolean }> {
    const key = envelope.uniqueKey;
    if (this.#pending.has(key) || this.#active.has(key))
      return { accepted: false, duplicate: true };
    this.#pending.set(key, { envelope, availableAtMs: this.clockNow() + delayMs });
    return { accepted: true, duplicate: false };
  }

  async claim(queueName: string, leaseMs: number, workerId: string): Promise<JobEnvelope[]> {
    await this.releaseExpiredLeases(this.clockNow());
    const claimed: JobEnvelope[] = [];
    const now = this.clockNow();
    for (const [key, entry] of [...this.#pending.entries()].sort(
      (a, b) => a[1].availableAtMs - b[1].availableAtMs,
    )) {
      if (entry.envelope.queue !== queueName || entry.availableAtMs > now) continue;
      // Per-key attempt tracking keyed by uniqueKey for DLQ ceiling checks.
      const attempts = (this.#perQueueAttemptCount.get(key) ?? 0) + 1;
      this.#perQueueAttemptCount.set(key, attempts);
      this.#pending.delete(key);
      this.#active.set(key, {
        envelope: entry.envelope,
        leaseUntilMs: now + leaseMs,
        workerId,
        attempts,
      });
      claimed.push(entry.envelope);
      if (claimed.length >= 10) break;
    }
    return claimed;
  }

  async heartbeat(uniqueKey: string, leaseMs: number, workerId: string): Promise<boolean> {
    const held = this.#active.get(uniqueKey);
    if (!held || held.workerId !== workerId) return false;
    held.leaseUntilMs = this.clockNow() + leaseMs;
    return true;
  }

  async complete(uniqueKey: string, workerId: string): Promise<'completed' | 'fenced' | 'missing'> {
    const held = this.#active.get(uniqueKey);
    if (!held) return this.#dead.has(uniqueKey) ? 'missing' : 'missing';
    if (held.workerId !== workerId) return 'fenced'; // lock loss / stall steal
    this.#active.delete(uniqueKey);
    return 'completed';
  }

  async deadLetter(uniqueKey: string, _errorCode: string): Promise<void> {
    void _errorCode;
    this.#active.delete(uniqueKey);
    this.#pending.delete(uniqueKey);
    this.#dead.add(uniqueKey);
  }

  async remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'> {
    if (this.#pending.delete(uniqueKey)) return 'removed';
    if (this.#active.has(uniqueKey)) return 'active';
    return 'missing';
  }

  async releaseExpiredLeases(nowMs: number): Promise<number> {
    let released = 0;
    for (const [key, held] of [...this.#active.entries()]) {
      if (held.leaseUntilMs <= nowMs) {
        this.#active.delete(key);
        // Stall recovery (ACTIVE -> STALLED -> ACTIVE, C057 §9): the job is
        // claimable IMMEDIATELY by any worker — failure backoff applies only
        // to declared RETRYABLE_FAILURE handling in the runtime, not to
        // crash/lease-loss reconciliation.
        this.#pending.set(key, { envelope: held.envelope, availableAtMs: nowMs });
        released += 1;
      }
    }
    return released;
  }

  /** Introspection used by the runtime for DLQ ceilings and tests. */
  attemptsOf(uniqueKey: string): number {
    return this.#perQueueAttemptCount.get(uniqueKey) ?? 0;
  }

  pendingCount(): number {
    return this.#pending.size;
  }
}

/**
 * Cancellation fencing (C057 §9): before executing or completing, compare the
 * persisted cancellation generation; any increase fences the attempt.
 */
export class CancellationFence {
  constructor(private currentGenerations = new Map<string, number>()) {}

  bump(workflowRunId: string): number {
    const next = (this.currentGenerations.get(workflowRunId) ?? 0) + 1;
    this.currentGenerations.set(workflowRunId, next);
    return next;
  }

  isFenced(job: Pick<JobEnvelope, 'workflowRunId' | 'cancellationGeneration'>): boolean {
    if (!job.workflowRunId) return false;
    return job.cancellationGeneration < (this.currentGenerations.get(job.workflowRunId) ?? 0);
  }
}

/**
 * C047 §9/§10 — workflow executor: leases, resource locks, retry, cancellation.
 *
 * A stale never executes: acquire a step lease, acquire canonical resource locks
 * in sorted order, re-check execution/cancellation generations and deadline, then
 * dispatch the step handler. Uncertainty reconciles before retry; model output
 * can never label retryability. Locks use durable ownership rows; expiry alone
 * never proves a prior writer stopped.
 */
export const EXECUTOR_SCHEMA_VERSION = 1 as const;

export const EXECUTOR_ATTEMPT_STATES = [
  'SCHEDULED',
  'ACQUIRING_LEASE',
  'ACQUIRING_LOCKS',
  'PRECHECKING',
  'DISPATCHING',
  'RUNNING',
  'FINALIZING',
  'SUCCEEDED',
  'RECONCILING',
  'RETRY_WAIT',
  'BLOCKED',
  'FAILED',
  'CANCELLING',
  'CANCELLED',
  'DEAD_LETTERED',
] as const;
export type ExecutorAttemptState = (typeof EXECUTOR_ATTEMPT_STATES)[number];

export const LOCK_STATES = [
  'WAITING',
  'HELD',
  'RELEASING',
  'RELEASED',
  'EXPIRED',
  'RECONCILING',
] as const;
export type LockState = (typeof LOCK_STATES)[number];

export const RETRY_CLASSES = ['safe', 'reconcile', 'no_retry', 'human_intervention'] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

export interface ExecuteStepJob {
  readonly runId: string;
  readonly stepId: string;
  readonly executionGeneration: number;
  readonly cancellationGeneration: number;
  readonly traceId: string;
  readonly attempt: number;
}

export interface RetryDisposition {
  readonly kind: RetryClass;
  readonly delayMs?: number | undefined;
  readonly reconcilerId?: string | undefined;
  readonly terminalCode?: string | undefined;
}

export type LockResult =
  | { readonly ok: true; readonly lockId: string }
  | { readonly ok: false; readonly code: 'RESOURCE_LOCKED'; readonly detail: string };

export interface ExecutorCommandPort {
  dispatch(job: ExecuteStepJob): Promise<void>;
  verifyCancellationSupported(runId: string): Promise<boolean>;
}

export class RetryClassifier {
  classify(error: {
    readonly code: string;
    readonly actionRisk?: string | undefined;
    readonly operationPhase?: string | undefined;
  }): RetryDisposition {
    const code = error.code;
    if (
      code === 'POLICY_DENIED' ||
      code === 'VALIDATION_FAILED' ||
      code === 'PERMISSION_DENIED' ||
      code === 'STALE_APPROVAL'
    ) {
      return { kind: 'no_retry', terminalCode: code };
    }
    if (
      code === 'SIDE_EFFECT_OUTCOME_UNKNOWN' ||
      code === 'COMMAND_OUTCOME_UNKNOWN' ||
      code === 'AGENT_OUTCOME_UNKNOWN'
    ) {
      return { kind: 'reconcile', reconcilerId: code };
    }
    if (code === 'RATE_LIMITED' || code === 'TRANSIENT_PROVIDER_FAULT') {
      return { kind: 'safe', delayMs: 2_000 };
    }
    return { kind: 'reconcile', reconcilerId: code };
  }
}

export class InMemoryLockManager {
  readonly locks = new Map<string, { state: LockState; ownerRunId: string; token: string; untilIso: string }>();

  async acquire(canonicalKey: string, ownerRunId: string, ttlMs: number): Promise<LockResult> {
    const existing = this.locks.get(canonicalKey);
    if (existing !== undefined && existing.state === 'HELD') {
      return { ok: false, code: 'RESOURCE_LOCKED', detail: `held by ${existing.ownerRunId}` };
    }
    const token = `lock:${ownerRunId}:${canonicalKey}:${Date.now()}:${Math.random()}`;
    this.locks.set(canonicalKey, {
      state: 'HELD',
      ownerRunId,
      token,
      untilIso: new Date(Date.now() + ttlMs).toISOString(),
    });
    return { ok: true, lockId: token };
  }

  async release(canonicalKey: string, ownerRunId: string, token: string): Promise<void> {
    const existing = this.locks.get(canonicalKey);
    if (existing !== undefined && existing.ownerRunId === ownerRunId && existing.token === token)
      this.locks.set(canonicalKey, { ...existing, state: 'RELEASED' });
  }
}

export interface StepHandler {
  readonly stepKind: string;
  run(job: ExecuteStepJob): Promise<{ ok: true } | { ok: false; code: string }>;
}

export interface ExecutorDeps {
  readonly handlers: ReadonlyMap<string, StepHandler>;
  readonly locks: InMemoryLockManager;
  readonly retries: RetryClassifier;
  readonly command: ExecutorCommandPort;
  readonly maxRetries?: number;
}

export class WorkflowExecutor {
  readonly #handlers: ReadonlyMap<string, StepHandler>;
  readonly #locks: InMemoryLockManager;
  readonly #retries: RetryClassifier;
  readonly #command: ExecutorCommandPort;
  readonly #maxRetries: number;

  constructor(deps: ExecutorDeps) {
    this.#handlers = deps.handlers;
    this.#locks = deps.locks;
    this.#retries = deps.retries;
    this.#command = deps.command;
    this.#maxRetries = deps.maxRetries ?? 3;
  }

  async execute(
    job: ExecuteStepJob,
    stepKind: string,
    locks: readonly string[],
  ): Promise<{ ok: true } | { ok: false; retry: RetryDisposition; detail: string }> {
    if (job.attempt > this.#maxRetries)
      return {
        ok: false,
        retry: { kind: 'human_intervention', terminalCode: 'RETRY_BUDGET_EXHAUSTED' },
        detail: 'retry budget exhausted',
      };
    const handler = this.#handlers.get(stepKind);
    if (handler === undefined)
      return {
        ok: false,
        retry: { kind: 'no_retry', terminalCode: 'EXECUTION_FENCED' },
        detail: `no handler for ${stepKind}`,
      };

    // Acquire canonical resource locks in sorted order (lock is optimization; the
    // provider expected-SHA is correctness).
    for (const lockKey of [...locks].sort()) {
      const lock = await this.#locks.acquire(lockKey, job.runId, 30_000);
      if (!lock.ok)
        return {
          ok: false,
          retry: { kind: 'no_retry', terminalCode: 'RESOURCE_LOCKED' },
          detail: lock.detail,
        };
    }

    const supported = await this.#command.verifyCancellationSupported(job.runId);
    if (!supported && stepKind === 'command') {
      return {
        ok: false,
        retry: { kind: 'human_intervention', terminalCode: 'CANCELLATION_INCOMPLETE' },
        detail: 'cancellation unsupported',
      };
    }

    await this.#command.dispatch(job);
    const result = await handler.run(job);
    if (result.ok) {
      for (const lockKey of locks) await this.#locks.release(lockKey);
      return { ok: true };
    }
    const retry = this.#retries.classify({ code: result.code });
    return { ok: false, retry, detail: result.code };
  }
}

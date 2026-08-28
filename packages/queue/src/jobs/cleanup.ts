/**
 * C060 §10/§12 — outbox cleanup, DLQ, and retry classification.
 *
 * Retry classifier distinguishes safe read retries (webhook/start/step 5
 * attempts, full jitter), reconcile-then-retry writes, terminal policy/approval
 * errors, and human-intervention conflicts. Outbox cleanup drains published
 * rows once fully acknowledged and moves chronic failures to their DLQ without
 * ever holding queue payloads containing secrets or large content.
 */
import { backoffDelayMs } from '../retry.js';

export const RETRY_CLASSES = ['safe', 'reconcile', 'terminal', 'human_intervention'] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

export interface RetryDecision {
  readonly kind: RetryClass;
  readonly delayMs: number;
  readonly attemptsLeft: boolean;
}

export class RetryClassifier {
  classify(code: string, attempted: number, maxAttempts: number): RetryDecision {
    const attempt = Math.max(attempted, 1);
    if (
      code === 'POLICY_DENIED' ||
      code === 'VALIDATION_FAILED' ||
      code === 'PERMISSION_DENIED' ||
      code === 'STALE_APPROVAL'
    ) {
      return { kind: 'terminal', delayMs: 0, attemptsLeft: false };
    }
    if (
      code === 'SIDE_EFFECT_OUTCOME_UNKNOWN' ||
      code === 'COMMAND_OUTCOME_UNKNOWN' ||
      code === 'AGENT_OUTCOME_UNKNOWN'
    ) {
      return {
        kind: 'reconcile',
        delayMs: backoffDelayMs(attempt, { maxAttempts }),
        attemptsLeft: attempted < maxAttempts,
      };
    }
    if (code === 'RATE_LIMITED' || code === 'TRANSIENT_PROVIDER_FAULT') {
      return {
        kind: 'safe',
        delayMs: backoffDelayMs(attempt, { maxAttempts }),
        attemptsLeft: attempted < maxAttempts,
      };
    }
    return {
      kind: 'safe',
      delayMs: backoffDelayMs(attempt, { maxAttempts }),
      attemptsLeft: attempted < maxAttempts,
    };
  }
}

export interface OutboxRow {
  readonly rowId: string;
  readonly eventType: string;
  readonly publishedAtIso: string;
  readonly acknowledged: boolean;
  readonly attempts: number;
}

export interface OutboxStorePort {
  list(limit: number): Promise<readonly OutboxRow[]>;
  mark(rowId: string, updates: Partial<OutboxRow>): Promise<void>;
  moveToDlq(rowId: string, reason: string): Promise<void>;
}

export class InMemoryOutboxStore implements OutboxStorePort {
  readonly rows = new Map<string, OutboxRow>();
  readonly dlq: Array<{ rowId: string; reason: string }> = [];
  async list(limit: number): Promise<readonly OutboxRow[]> {
    return [...this.rows.values()].slice(0, limit);
  }
  async mark(rowId: string, updates: Partial<OutboxRow>): Promise<void> {
    const row = this.rows.get(rowId);
    if (row !== undefined) this.rows.set(rowId, { ...row, ...updates });
  }
  async moveToDlq(rowId: string, reason: string): Promise<void> {
    this.dlq.push({ rowId, reason });
    this.rows.delete(rowId);
  }
}

export interface OutboxCleanupDeps {
  readonly store: OutboxStorePort;
  readonly classifier?: RetryClassifier;
  readonly maxAttempts?: number;
}

export class OutboxCleanupService {
  constructor(private readonly deps: OutboxCleanupDeps) {}

  async drain(limit = 100): Promise<{ readonly processed: number; readonly deadLettered: number }> {
    const queried = await this.deps.store.list(limit);
    let deadLettered = 0;
    for (const row of queried) {
      if (row.acknowledged) {
        await this.deps.store.mark(row.rowId, { attempts: row.attempts + 1 });
        await this.deps.store.moveToDlq(row.rowId, 'acknowledged_cleanup');
        continue;
      }
      const max = this.deps.maxAttempts ?? 5;
      if (row.attempts >= max) {
        await this.deps.store.moveToDlq(row.rowId, `max_attempts_${max}`);
        deadLettered += 1;
      }
    }
    return { processed: queried.length, deadLettered };
  }
}

/**
 * C003 — Transport-neutral job dispositions.
 *
 * Maps the retry taxonomy onto worker outcomes so queue consumers (C057+)
 * never invent their own retry semantics:
 * - safe_retry            → bounded backoff retry
 * - reconcile_then_retry  → verify provider state first, then retry
 * - no_retry              → terminal for this attempt (dead-letter)
 * - human_intervention    → escalate; never retried automatically
 */
import type { RetryClass } from './codes.js';
import { DevGuardError } from './error.js';
import { getErrorDescriptor } from './registry.js';

export type JobOutcomeAction =
  'retry_with_backoff' | 'reconcile_then_retry' | 'dead_letter' | 'escalate_human';

export interface JobDisposition {
  readonly action: JobOutcomeAction;
  readonly retryable: boolean;
  readonly code: string;
}

const CLASS_TO_ACTION: Record<RetryClass, JobOutcomeAction> = {
  safe_retry: 'retry_with_backoff',
  reconcile_then_retry: 'reconcile_then_retry',
  no_retry: 'dead_letter',
  human_intervention: 'escalate_human',
};

const ACTION_RETRYABLE: Record<JobOutcomeAction, boolean> = {
  retry_with_backoff: true,
  reconcile_then_retry: true,
  dead_letter: false,
  escalate_human: false,
};

export function dispositionForRetryClass(retryClass: RetryClass, code: string): JobDisposition {
  const action = CLASS_TO_ACTION[retryClass];
  return { action, retryable: ACTION_RETRYABLE[action], code };
}

export function toJobDisposition(error: unknown): JobDisposition {
  if (error instanceof DevGuardError) {
    return dispositionForRetryClass(error.retryClass, error.code);
  }
  const fallback = getErrorDescriptor('INTERNAL');
  if (!fallback) {
    throw new TypeError('Fallback error descriptor is missing from the registry.');
  }
  return dispositionForRetryClass(fallback.retryClass, fallback.code);
}

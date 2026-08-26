/**
 * C007 — Provider-neutral SQL statement shape and SQLSTATE retry classifier.
 *
 * All queries cross the UnitOfWork/repository boundary as parameterized
 * statements ($1 style). Values are never interpolated into `text` (C007 §13).
 */

/** A parameterized SQL statement. `values` binds positionally to $1…$n. */
export interface SqlStatement {
  readonly text: string;
  readonly values?: readonly unknown[];
}

/** Outcome of classifying a Postgres error by its SQLSTATE. */
export type RetryDecision = 'retry' | 'no_retry';

/**
 * SQLSTATEs that justify a bounded whole-transaction retry (C007 §18):
 * 40001 serialization_failure, 40P01 deadlock_detected.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

/** Map a SQLSTATE (or absence thereof) onto the retry taxonomy. */
export function classifySqlState(sqlState: string | undefined | null): RetryDecision {
  if (sqlState === undefined || sqlState === null) return 'no_retry';
  return RETRYABLE_SQLSTATES.has(sqlState) ? 'retry' : 'no_retry';
}

/**
 * Extract the SQLSTATE from a pg-style error (`error.code`) without importing
 * provider types beyond this package's own adapter surface.
 */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

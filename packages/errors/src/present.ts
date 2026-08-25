/**
 * C003 — Public projections.
 *
 * `PublicError` is the ONLY error shape that may cross a trust boundary (HTTP
 * response, job result payload). It carries stable code, fixed safe message,
 * request correlation, optionally schema-validated details, and retryability.
 */
import type { RetryClass } from './codes.js';
import { DevGuardError } from './error.js';
import { normalizeError } from './normalize.js';
import { getErrorDescriptor } from './registry.js';

export interface PublicError {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: unknown;
  readonly retryable: boolean;
}

export interface ErrorEnvelope {
  readonly error: PublicError;
}

function isRetryable(retryClass: RetryClass): boolean {
  return retryClass === 'safe_retry' || retryClass === 'reconcile_then_retry';
}

/** Project any thrown value into the public error shape. */
export function toPublicError(error: unknown, requestId: string): PublicError {
  const normalized = error instanceof DevGuardError ? error : normalizeError(error);
  const pub: PublicError = {
    code: normalized.code,
    message: normalized.message,
    requestId,
    retryable: isRetryable(normalized.retryClass),
  };
  if (normalized.safeDetails !== undefined) {
    return { ...pub, details: normalized.safeDetails };
  }
  return pub;
}

/** Common HTTP envelope owned by C005 transports. */
export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  return { error: toPublicError(error, requestId) };
}

/** Deterministic HTTP status for a code; unknown codes map to 500. */
export function httpStatusForCode(code: string): number {
  return getErrorDescriptor(code)?.httpStatus ?? 500;
}

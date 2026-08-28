/**
 * C041/C042 — sandbox error codes.
 *
 * New codes enter the global registry exactly once via `registerError`
 * (idempotent for identical descriptors; conflicts throw). Rules per C003:
 * SCREAMING_SNAKE_CASE codes, httpStatus from the mapped set, retryClass from
 * the fixed taxonomy. Where a stable code already exists (@devguard/errors)
 * it is reused instead of re-registered.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

/**
 * Shared detail-schema factory: every sandbox detail payload is a single
 * strict object of bounded strings so the public error surface stays small
 * and injectable values never enter safe messages.
 */
function detailSchema(fields: readonly string[]): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const key of fields) {
    shape[key] = z.string().min(1).max(200);
  }
  return z.object(shape).strict();
}

// ---------------------------------------------------------------------------
// C041 — workspace checkout
// ---------------------------------------------------------------------------

registerError({
  code: 'SANDBOX_CAPABILITY_UNSUPPORTED',
  category: 'integration',
  httpStatus: 501,
  retryClass: 'human_intervention',
  safeMessage: 'A required sandbox provider capability is missing or unverified.',
  detailSchema: detailSchema(['capability']),
});

registerError({
  code: 'SANDBOX_ISOLATION_UNVERIFIED',
  category: 'security',
  httpStatus: 501,
  retryClass: 'human_intervention',
  safeMessage: 'Sandbox isolation could not be verified; execution is blocked.',
  detailSchema: detailSchema(['capability']),
});

registerError({
  code: 'REF_CHANGED',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The requested repository ref moved or is no longer resolvable.',
  detailSchema: detailSchema(['requestedRef']),
});

registerError({
  code: 'CHECKOUT_MISMATCH',
  category: 'security',
  httpStatus: 422,
  retryClass: 'no_retry',
  safeMessage: 'The checked-out repository does not match the authorized revision.',
  detailSchema: detailSchema(['expectedSha', 'observedSha', 'mismatchKind']),
});

registerError({
  code: 'WORKSPACE_QUARANTINED',
  category: 'security',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The sandbox workspace has been quarantined and must not be used.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'WORKSPACE_ILLEGAL_TRANSITION',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The workspace state transition is not permitted.',
  detailSchema: detailSchema(['from', 'trigger']),
});

registerError({
  code: 'WORKSPACE_FENCE_REJECTED',
  category: 'concurrency',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The workspace fence (lease/generation) does not match the durable record.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'WORKSPACE_REPLAY_MISMATCH',
  category: 'concurrency',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'Idempotent workspace replay does not match the original create-request binding.',
  detailSchema: detailSchema(['field']),
});

// ---------------------------------------------------------------------------
// C042 — command execution and timeouts
// ---------------------------------------------------------------------------

registerError({
  code: 'COMMAND_NOT_AUTHORIZED',
  category: 'authorization',
  httpStatus: 403,
  retryClass: 'no_retry',
  safeMessage: 'The command has no current persisted authorization to execute.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'COMMAND_DIGEST_MISMATCH',
  category: 'authorization',
  httpStatus: 422,
  retryClass: 'no_retry',
  safeMessage: 'The command does not match the authorized canonical digest.',
  detailSchema: detailSchema(['expectedDigest', 'actualDigest']),
});

registerError({
  code: 'COMMAND_TIMEOUT_INVALID',
  category: 'validation',
  httpStatus: 400,
  retryClass: 'no_retry',
  safeMessage: 'The command deadline is missing or outside permitted bounds.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'COMMAND_ILLEGAL_TRANSITION',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The command state transition is not permitted.',
  detailSchema: detailSchema(['from', 'trigger']),
});

registerError({
  code: 'COMMAND_FENCE_REJECTED',
  category: 'concurrency',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The command fence (lease/generation) does not match the durable record.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'COMMAND_ARGV_UNSAFE',
  category: 'validation',
  httpStatus: 400,
  retryClass: 'no_retry',
  safeMessage: 'The command argv, cwd, or environment reference is unsafe.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'COMMAND_SHELL_MODE_DENIED',
  category: 'authorization',
  httpStatus: 403,
  retryClass: 'no_retry',
  safeMessage: 'Shell-string execution is denied for this command.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'SANDBOX_CANCEL_UNSUPPORTED',
  category: 'integration',
  httpStatus: 501,
  retryClass: 'human_intervention',
  safeMessage: 'The sandbox provider cannot verify command cancellation or tree termination.',
  detailSchema: detailSchema(['operation']),
});

registerError({
  code: 'COMMAND_OUTCOME_UNKNOWN',
  category: 'integration',
  httpStatus: 500,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The sandbox provider outcome for this command is ambiguous and unresolved.',
  detailSchema: detailSchema(['operation']),
});

registerError({
  code: 'SANDBOX_HOST_EXECUTION_BLOCKED',
  category: 'security',
  httpStatus: 500,
  retryClass: 'no_retry',
  safeMessage: 'Sandbox invariant violated: execution on the DevGuard host is never permitted.',
  detailSchema: detailSchema(['operation']),
});

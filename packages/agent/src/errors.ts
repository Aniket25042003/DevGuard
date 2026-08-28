/**
 * C036 — agent (TrueForge contract adapter) error codes.
 *
 * New codes enter the global registry exactly once via `registerError`
 * (idempotent for identical descriptors; conflicts throw). Rules per C003:
 * SCREAMING_SNAKE_CASE codes, httpStatus from the mapped set, retryClass from
 * the fixed taxonomy. Where a stable code already exists (@devguard/errors) it
 * is reused instead of re-registered.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

/** Bounded, injectable-free detail schema factory. */
function detailSchema(fields: readonly string[]): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {};
  for (const key of fields) {
    shape[key] = z.string().min(1).max(200);
  }
  return z.object(shape).strict();
}

/**
 * A required runtime capability is missing or unverified; the affected feature
 * stays disabled and never falls back permissively. Mirrors the sandbox's
 * provider-capability contract at the agent boundary.
 */
registerError({
  code: 'RUNTIME_CAPABILITY_UNAVAILABLE',
  category: 'integration',
  httpStatus: 501,
  retryClass: 'human_intervention',
  safeMessage: 'A required agent-runtime capability is missing or unverified.',
  detailSchema: detailSchema(['capability']),
});

registerError({
  code: 'AGENT_CONTRACT_INCOMPATIBLE',
  category: 'integration',
  httpStatus: 501,
  retryClass: 'human_intervention',
  safeMessage: 'The connected agent runtime does not match DevGuard contract requirements.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'AGENT_SNAPSHOT_STALE',
  category: 'integration',
  httpStatus: 503,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The agent contract snapshot is stale and must be reverified.',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'AGENT_AUTH_DENIED',
  category: 'integration',
  httpStatus: 401,
  retryClass: 'no_retry',
  safeMessage: 'The agent runtime rejected DevGuard credentials (server-side secret auth).',
  detailSchema: detailSchema(['reason']),
});

registerError({
  code: 'AGENT_RESPONSE_SCHEMA_REJECTED',
  category: 'integration',
  httpStatus: 500,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The agent runtime returned a response that violates the pinned contract schema.',
  detailSchema: detailSchema(['kind']),
});

registerError({
  code: 'AGENT_COMPATIBILITY_ILLEGAL_TRANSITION',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The agent compatibility state transition is not permitted without evidence.',
  detailSchema: detailSchema(['from', 'trigger']),
});

registerError({
  code: 'AGENT_VERIFICATION_UNSAFE',
  category: 'security',
  httpStatus: 500,
  retryClass: 'human_intervention',
  safeMessage:
    'Agent contract verification attempted something outside the read-only probe surface.',
  detailSchema: detailSchema(['reason']),
});

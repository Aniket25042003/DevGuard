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

// ---- C039 MCP policy gateway error codes ----
registerError({
  code: 'TOOL_CALL_NOT_FOUND',
  category: 'domain',
  httpStatus: 404,
  retryClass: 'no_retry',
  safeMessage: 'The tool-call intent does not exist.',
  detailSchema: detailSchema([]),
});
registerError({
  code: 'TOOL_ACTION_MISMATCH',
  category: 'security',
  httpStatus: 422,
  retryClass: 'no_retry',
  safeMessage: 'The authorized action does not match the tool-call intent.',
  detailSchema: detailSchema([]),
});
registerError({
  code: 'AUTHORIZED_GRANT_REQUIRED',
  category: 'security',
  httpStatus: 403,
  retryClass: 'no_retry',
  safeMessage: 'Authorized execution requires an explicit approved grant.',
  detailSchema: detailSchema([]),
});
// ---- C037/C038 session/turn lifecycle error codes ----
registerError({
  code: 'SESSION_NOT_FOUND',
  category: 'domain',
  httpStatus: 404,
  retryClass: 'no_retry',
  safeMessage: 'The requested agent session does not exist.',
  detailSchema: detailSchema(['sessionId']),
});
registerError({
  code: 'SESSION_FAILED',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The agent session ended in a failed state and cannot be reused.',
  detailSchema: detailSchema(['sessionId']),
});
registerError({
  code: 'SESSION_TERMINAL',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The agent session is terminal and cannot accept new turns.',
  detailSchema: detailSchema(['status']),
});
registerError({
  code: 'SESSION_VERSION_CONFLICT',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The agent session version changed under a concurrent worker.',
  detailSchema: detailSchema([]),
});
registerError({
  code: 'SESSION_CREATE_FAILED',
  category: 'integration',
  httpStatus: 503,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The agent runtime could not create the session.',
  detailSchema: detailSchema(['code']),
});
registerError({
  code: 'SESSION_CANCEL_FAILED',
  category: 'integration',
  httpStatus: 503,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'The agent runtime could not cancel the session.',
  detailSchema: detailSchema(['code']),
});
registerError({
  code: 'SESSION_TURN_ACTIVE',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'A turn is already active for this agent session.',
  detailSchema: detailSchema(['sessionId']),
});
registerError({
  code: 'TURN_NOT_FOUND',
  category: 'domain',
  httpStatus: 404,
  retryClass: 'no_retry',
  safeMessage: 'The requested agent turn does not exist.',
  detailSchema: detailSchema(['turnId']),
});
registerError({
  code: 'TURN_GENERATION_STALE',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The turn was submitted against a stale cancellation generation.',
  detailSchema: detailSchema(['actual']),
});
registerError({
  code: 'TURN_COMMAND_DIGEST_CONFLICT',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The turn command id was reused with different inputs.',
  detailSchema: detailSchema([]),
});
registerError({
  code: 'REQUIRED_ACTION_RESULT_LINK_REQUIRED',
  category: 'domain',
  httpStatus: 422,
  retryClass: 'no_retry',
  safeMessage: 'A required-action result must reference the paused turn it continues.',
  detailSchema: detailSchema([]),
});

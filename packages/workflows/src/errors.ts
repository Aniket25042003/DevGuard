/**
 * C047/C048 — workflow executor/validation error codes.
 *
 * New codes enter the global registry exactly once via `registerError`
 * (idempotent for identical descriptors). Rules per C003: SCREAMING_SNAKE_CASE
 * codes, httpStatus from the mapped set, retryClass from the fixed taxonomy.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

const emptyDetail = z.object({}).strict();

registerError({
  code: 'RESOURCE_LOCKED',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The workflow step is blocked by a resource lock held by another run.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'EXECUTION_FENCED',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The execution generation or staleness fence rejected the step.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'RETRY_BUDGET_EXHAUSTED',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'human_intervention',
  safeMessage: 'The step exceeded its durable retry budget.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'VALIDATION_EVIDENCE_STALE',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'reconcile_then_retry',
  safeMessage: 'Validation evidence is stale and must be re-collected.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'OUTCOME_CONTRACT_INVALID',
  category: 'domain',
  httpStatus: 500,
  retryClass: 'no_retry',
  safeMessage: 'The workflow outcome violates its contract.',
  detailSchema: emptyDetail,
});

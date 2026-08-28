/**
 * C045/C046 — workflow registry/run error codes.
 *
 * New codes enter the global registry exactly once via `registerError`
 * (idempotent for identical descriptors). Rules per C003: SCREAMING_SNAKE_CASE
 * codes, httpStatus from the mapped set, retryClass from the fixed taxonomy.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

const emptyDetail = z.object({}).strict();

registerError({
  code: 'RUN_NOT_FOUND',
  category: 'domain',
  httpStatus: 404,
  retryClass: 'no_retry',
  safeMessage: 'The workflow run does not exist.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'RUN_ILLEGAL_TRANSITION',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The workflow run state transition is not permitted.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'STEP_NOT_FOUND',
  category: 'domain',
  httpStatus: 404,
  retryClass: 'no_retry',
  safeMessage: 'The workflow step does not exist.',
  detailSchema: emptyDetail,
});
registerError({
  code: 'STEP_ILLEGAL_TRANSITION',
  category: 'domain',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The workflow step state transition is not permitted.',
  detailSchema: emptyDetail,
});

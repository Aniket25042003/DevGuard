/**
 * C014/C015/C016 — component error codes registered via @devguard/errors.
 *
 * Registration is module-level and idempotent for identical descriptors, so
 * importing this module more than once is safe. Codes are SCREAMING_SNAKE_CASE
 * and never repurposed once shipped.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

registerError({
  code: 'REPOSITORY_MAP_NOT_READY',
  category: 'application',
  httpStatus: 409,
  retryClass: 'no_retry',
  safeMessage: 'The repository map is not ready to answer this query.',
  detailSchema: z.object({
    status: z.string().min(1).max(16),
  }),
});

registerError({
  code: 'INSTRUCTION_TRUST_REJECTED',
  category: 'security',
  httpStatus: 403,
  retryClass: 'no_retry',
  safeMessage: 'Instruction trust resolution was rejected and cannot serve context.',
  detailSchema: z.object({
    reasonCode: z.string().min(1).max(64),
  }),
});

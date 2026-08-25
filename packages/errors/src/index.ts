/**
 * @devguard/errors — provider-neutral typed error taxonomy (C003).
 *
 * Boundary rule: adapters translate SDK failures into registered codes at
 * their own edge; raw SDK error types never cross package boundaries.
 */
export type { DetailSchema, ErrorCategory, ErrorDescriptor, RetryClass } from './codes.js';
export { FOUNDATION_ERROR_DESCRIPTORS } from './codes.js';
export type { KnownErrorCode } from './codes.js';

export {
  assertRegistryIntegrity,
  getErrorDescriptor,
  listErrorDescriptors,
  registerError,
} from './registry.js';

export {
  configurationInvalid,
  dependencyUnavailable,
  DevGuardError,
  idempotencyKeyConflict,
  internalError,
  makeError,
  notFound,
  providerRateLimited,
  providerUnavailable,
  rateLimited,
  repositoryForbidden,
  unauthenticated,
  validationFailed,
  versionConflict,
} from './error.js';
export type { DevGuardErrorOptions } from './error.js';

export { FALLBACK_ERROR_CODE, normalizeError } from './normalize.js';

export { httpStatusForCode, toErrorEnvelope, toPublicError } from './present.js';
export type { ErrorEnvelope, PublicError } from './present.js';

export { dispositionForRetryClass, toJobDisposition } from './job-disposition.js';
export type { JobDisposition, JobOutcomeAction } from './job-disposition.js';

export { presentHttpError, runJobWithDisposition } from './integrations.js';
export type { HttpErrorResponse, JobRunResult } from './integrations.js';

/**
 * C096 §9 — harness-scoped error codes.
 *
 * The dev-only harness registers its own descriptors instead of reusing
 * product codes so evidence reports can distinguish "product failed" from
 * "the test infrastructure itself failed" (C096 §18 preflight rule).
 */
import type { ErrorDescriptor } from '@devguard/errors';
import { makeError as makeDevGuardError, registerError } from '@devguard/errors';

const HARNESS_ERROR_DESCRIPTORS: readonly ErrorDescriptor[] = [
  {
    code: 'TEST_RUNTIME_CLOSED',
    category: 'application',
    httpStatus: 500,
    retryClass: 'no_retry',
    safeMessage: 'Test runtime has already completed cleanup and cannot be used again.',
  },
  {
    code: 'TEST_INFRASTRUCTURE',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'no_retry',
    safeMessage:
      'Test infrastructure is unavailable or failed preflight; this is an infrastructure failure, not a product failure.',
  },
] as const;

let registered = false;

/** Idempotent registration; registry itself rejects conflicting redefinition. */
export function registerErrorDescriptors(): void {
  if (registered) return;
  for (const descriptor of HARNESS_ERROR_DESCRIPTORS) registerError(descriptor);
  registered = true;
}

export const TEST_RUNTIME_CLOSED = 'TEST_RUNTIME_CLOSED' as const;
export const TEST_INFRASTRUCTURE_CODE = 'TEST_INFRASTRUCTURE' as const;

/** Construct a registered harness error by code. */
export function makeError(
  code: typeof TEST_RUNTIME_CLOSED | typeof TEST_INFRASTRUCTURE_CODE,
): ReturnType<typeof makeDevGuardError> {
  registerErrorDescriptors();
  return makeDevGuardError(code, { details: undefined });
}

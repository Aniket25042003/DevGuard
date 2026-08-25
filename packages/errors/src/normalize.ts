/**
 * C003 — Unknown-value normalizer.
 *
 * Any thrown value becomes a DevGuardError without leaking raw content into
 * public surfaces. Original values are preserved only as the internal `cause`
 * for redacting log tooling.
 */
import type { DevGuardErrorOptions } from './error.js';
import { DevGuardError } from './error.js';
import { getErrorDescriptor } from './registry.js';

export const FALLBACK_ERROR_CODE = 'INTERNAL';

/** Redact anything that could carry content: strings, objects, symbols… */
function describeUnknown(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string(${value.length} chars)`;
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `array(${value.length})`;
    return 'object';
  }
  return typeof value;
}

/**
 * Convert an unknown thrown value into a registered DevGuardError.
 * - DevGuardError instances pass through untouched.
 * - Errors are wrapped with INTERNAL; the original becomes the internal cause.
 * - Anything else is wrapped with a type-shape description as cause.
 */
export function normalizeError(value: unknown, options?: DevGuardErrorOptions): DevGuardError {
  if (value instanceof DevGuardError) return value;
  const descriptor = getErrorDescriptor(FALLBACK_ERROR_CODE);
  if (!descriptor) {
    throw new TypeError('Fallback error descriptor is missing from the registry.');
  }
  if (value instanceof Error) {
    return new DevGuardError(descriptor, {
      ...options,
      cause: options?.cause ?? value,
    });
  }
  return new DevGuardError(descriptor, {
    ...options,
    cause: options?.cause ?? describeUnknown(value),
  });
}

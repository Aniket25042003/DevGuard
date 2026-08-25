/**
 * C003 — DevGuardError base class and category factories.
 *
 * Invariants:
 * - Public metadata (code/message/retryClass/safeDetails) is immutable and safe.
 * - The original cause and stack are internal: they never serialize, and only
 *   redacting log tooling (C061/C093) may consume them.
 * - Safe details are validated against the code's detail schema at
 *   construction; invalid details are rejected instead of sanitized silently.
 */
import type { ErrorCategory, ErrorDescriptor, RetryClass } from './codes.js';
import { getErrorDescriptor } from './registry.js';

export interface DevGuardErrorOptions {
  /** Pre-validated safe details; validated again against the descriptor schema. */
  readonly details?: unknown;
  /** Internal cause preserved for correlated logging only. */
  readonly cause?: unknown;
}

export class DevGuardError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryClass: RetryClass;
  readonly safeDetails?: unknown;

  constructor(descriptor: ErrorDescriptor, options: DevGuardErrorOptions = {}) {
    super(descriptor.safeMessage, { cause: options.cause });
    this.name = 'DevGuardError';
    this.code = descriptor.code;
    this.category = descriptor.category;
    this.retryClass = descriptor.retryClass;
    if (options.details !== undefined) {
      this.safeDetails = deepFreezeDetails(validateDetails(descriptor, options.details));
    }
    // Keep the prototype chain intact when targeting ES2023 output.
    Object.setPrototypeOf(this, new.target.prototype);
    // Stack remains available internally but is excluded from enumeration/JSON.
    Object.defineProperty(this, 'stack', { enumerable: false, configurable: true });
  }

  /**
   * Safe projection used by logs that have not integrated the C061 redactor
   * yet. Excludes cause and stack by construction.
   */
  toSafeLogFields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      code: this.code,
      category: this.category,
      retryClass: this.retryClass,
      message: this.message,
    };
    if (this.safeDetails !== undefined) fields['details'] = this.safeDetails;
    return fields;
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      code: this.code,
      message: this.message,
      category: this.category,
      retryClass: this.retryClass,
    };
    if (this.safeDetails !== undefined) json['details'] = this.safeDetails;
    return json;
  }
}

/**
 * Defensive immutability: readonly type annotations do not protect nested
 * arrays/objects at runtime. Frozen details cannot be mutated between
 * construction and public serialization.
 */
function deepFreezeDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach((element) => deepFreezeDetails(element));
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeDetails(nested);
    }
    return Object.freeze(value);
  }
  return value;
}

function validateDetails(descriptor: ErrorDescriptor, details: unknown): unknown {
  const schema = descriptor.detailSchema;
  if (!schema) {
    // Fail closed: this code declares no public detail surface.
    throw new TypeError(`Error code '${descriptor.code}' does not permit public details.`);
  }
  const result = schema.safeParse(details);
  if (!result.success) {
    throw new TypeError(`Safe details rejected for error code '${descriptor.code}'.`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** Resolve a descriptor or fail closed with a stable error. */
function requireDescriptor(code: string): ErrorDescriptor {
  const descriptor = getErrorDescriptor(code);
  if (!descriptor) {
    throw new TypeError(`Unregistered error code '${code}'. Register it before throwing.`);
  }
  return descriptor;
}

export function makeError(code: string, options?: DevGuardErrorOptions): DevGuardError {
  return new DevGuardError(requireDescriptor(code), options);
}

export const validationFailed = (
  issues: ReadonlyArray<{ path: string; constraint: string }>,
  cause?: unknown,
): DevGuardError => makeError('VALIDATION_FAILED', { details: issues, cause });

export const unauthenticated = (cause?: unknown): DevGuardError =>
  makeError('UNAUTHENTICATED', { cause });

export const repositoryForbidden = (cause?: unknown): DevGuardError =>
  makeError('REPOSITORY_FORBIDDEN', { cause });

export const notFound = (cause?: unknown): DevGuardError => makeError('NOT_FOUND', { cause });

export const versionConflict = (
  expectedVersion: number,
  currentVersion: number,
  cause?: unknown,
): DevGuardError =>
  makeError('VERSION_CONFLICT', {
    details: { expectedVersion, currentVersion },
    cause,
  });

export const idempotencyKeyConflict = (cause?: unknown): DevGuardError =>
  makeError('IDEMPOTENCY_KEY_CONFLICT', { cause });

export const rateLimited = (cause?: unknown): DevGuardError => makeError('RATE_LIMITED', { cause });

export const dependencyUnavailable = (cause?: unknown): DevGuardError =>
  makeError('DEPENDENCY_UNAVAILABLE', { cause });

export const providerUnavailable = (cause?: unknown): DevGuardError =>
  makeError('PROVIDER_UNAVAILABLE', { cause });

export const providerRateLimited = (cause?: unknown): DevGuardError =>
  makeError('PROVIDER_RATE_LIMITED', { cause });

export const configurationInvalid = (
  issues: ReadonlyArray<{ path: string; constraint: string }>,
  cause?: unknown,
): DevGuardError => makeError('CONFIGURATION_INVALID', { details: issues, cause });

export const internalError = (cause?: unknown): DevGuardError => makeError('INTERNAL', { cause });

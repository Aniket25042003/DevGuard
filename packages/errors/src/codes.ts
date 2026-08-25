/**
 * C003 — Stable error codes, categories, retry classes, and descriptors.
 *
 * Naming rules:
 * - Codes are SCISSOR_CASE, globally unique, and never repurposed or removed
 *   once shipped (see docs/architecture/error-code-catalog.md).
 * - New codes enter through `registerError` with a complete descriptor;
 *   duplicates or incomplete descriptors fail fast.
 */
import { z } from 'zod';

/** Transport-neutral retry taxonomy (C003 §2/§4.3). */
export type RetryClass = 'safe_retry' | 'reconcile_then_retry' | 'no_retry' | 'human_intervention';

export type ErrorCategory =
  | 'domain'
  | 'application'
  | 'integration'
  | 'persistence'
  | 'configuration'
  | 'authorization'
  | 'concurrency'
  | 'validation';

/**
 * Runtime schema every public detail payload must satisfy before it may be
 * attached to an error or serialized to a client. `undefined` means the code
 * carries no public details at all.
 */
export type DetailSchema = z.ZodType<unknown> | undefined;

export interface ErrorDescriptor {
  /** Globally unique stable identifier. */
  readonly code: string;
  readonly category: ErrorCategory;
  /** HTTP status used by the API transport mapping (C005 owns envelopes). */
  readonly httpStatus: number;
  readonly retryClass: RetryClass;
  /** Fixed, user-safe message. Never embeds dynamic input. */
  readonly safeMessage: string;
  readonly detailSchema?: DetailSchema;
}

const HTTP_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 501, 503] as const;

/** Structural validation shared with the registry's fail-fast registration path. */
export function assertDescriptor(descriptor: ErrorDescriptor): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(descriptor.code)) {
    throw new TypeError(`Error code '${descriptor.code}' must be SCREAMING_SNAKE_CASE.`);
  }
  if (!(HTTP_STATUSES as readonly number[]).includes(descriptor.httpStatus)) {
    throw new TypeError(
      `Error code '${descriptor.code}' has unmapped HTTP status ${descriptor.httpStatus}.`,
    );
  }
  if (descriptor.safeMessage.trim().length < 8) {
    throw new TypeError(`Error code '${descriptor.code}' needs a meaningful safe message.`);
  }
}

/** Foundation error codes. Later components extend via `registerError`. */
export const FOUNDATION_ERROR_DESCRIPTORS = [
  {
    code: 'VALIDATION_FAILED',
    category: 'validation',
    httpStatus: 400,
    retryClass: 'no_retry',
    safeMessage: 'The submitted input failed validation.',
    detailSchema: z
      .array(z.object({ path: z.string().min(1), constraint: z.string().min(1) }))
      .max(100),
  },
  {
    code: 'UNAUTHENTICATED',
    category: 'authorization',
    httpStatus: 401,
    retryClass: 'no_retry',
    safeMessage: 'Authentication is required.',
  },
  {
    code: 'REPOSITORY_FORBIDDEN',
    category: 'authorization',
    httpStatus: 403,
    retryClass: 'no_retry',
    // Constant regardless of existence/membership to resist enumeration (§17).
    safeMessage: 'You do not have access to this repository.',
  },
  {
    code: 'NOT_FOUND',
    category: 'application',
    httpStatus: 404,
    retryClass: 'no_retry',
    safeMessage: 'The requested resource was not found.',
  },
  {
    code: 'VERSION_CONFLICT',
    category: 'concurrency',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'The resource changed concurrently; reload and try again.',
    detailSchema: z.object({
      expectedVersion: z.number().int().nonnegative(),
      currentVersion: z.number().int().nonnegative(),
    }),
  },
  {
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    category: 'concurrency',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'This operation key was already used with different content.',
  },
  {
    code: 'RATE_LIMITED',
    category: 'application',
    httpStatus: 429,
    retryClass: 'safe_retry',
    safeMessage: 'Too many requests. Slow down and retry shortly.',
  },
  {
    code: 'DEPENDENCY_UNAVAILABLE',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'reconcile_then_retry',
    safeMessage: 'A required service is temporarily unavailable.',
  },
  {
    code: 'PROVIDER_UNAVAILABLE',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'reconcile_then_retry',
    safeMessage: 'The external provider is temporarily unavailable.',
  },
  {
    code: 'PROVIDER_RATE_LIMITED',
    category: 'integration',
    httpStatus: 429,
    retryClass: 'safe_retry',
    safeMessage: 'The external provider rate limit was reached.',
  },
  {
    code: 'CONFIGURATION_INVALID',
    category: 'configuration',
    httpStatus: 500,
    retryClass: 'no_retry',
    safeMessage: 'Service configuration is invalid.',
    detailSchema: z
      .array(z.object({ path: z.string().min(1), constraint: z.string().min(1) }))
      .max(200),
  },
  {
    code: 'INTERNAL',
    category: 'application',
    httpStatus: 500,
    retryClass: 'human_intervention',
    safeMessage: 'An unexpected error occurred.',
  },
] as const satisfies readonly ErrorDescriptor[];

/** Known foundation codes as a literal union for ergonomic switches. */
export type KnownErrorCode = (typeof FOUNDATION_ERROR_DESCRIPTORS)[number]['code'];

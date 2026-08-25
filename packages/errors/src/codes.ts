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
  | 'validation'
  | 'security';

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

const HTTP_STATUSES = [400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 501, 503] as const;

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
  // ---- Security boundary codes (C092/C093) ----
  {
    code: 'PROVENANCE_INVALID',
    category: 'validation',
    httpStatus: 400,
    retryClass: 'no_retry',
    safeMessage: 'Content provenance could not be verified.',
    detailSchema: z.object({ field: z.string().max(64) }),
  },
  {
    code: 'TRUST_ITEM_INVALID_TRANSITION',
    category: 'domain',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'Trust evaluation state transition is not allowed.',
    detailSchema: z.object({
      from: z.string().min(1).max(32),
      to: z.string().min(1).max(32),
    }),
  },
  {
    code: 'CONTENT_QUARANTINED',
    category: 'domain',
    httpStatus: 403,
    retryClass: 'no_retry',
    safeMessage: 'This content was quarantined and cannot be used.',
    detailSchema: z.object({ reasonCode: z.string().min(1).max(128) }),
  },
  {
    code: 'UNTRUSTED_PROPOSAL_REJECTED',
    category: 'authorization',
    httpStatus: 403,
    retryClass: 'no_retry',
    safeMessage: 'The proposal carried untrusted authorization data and was rejected.',
    detailSchema: z.object({
      strippedFields: z.array(z.string().max(64)).max(16),
    }),
  },
  {
    code: 'SECRET_ACCESS_DENIED',
    category: 'authorization',
    httpStatus: 403,
    retryClass: 'no_retry',
    safeMessage: 'Access to this secret is not permitted for the caller.',
  },
  {
    code: 'SECRET_UNAVAILABLE',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'safe_retry',
    safeMessage: 'The requested secret is unavailable or expired.',
  },
  {
    code: 'SECRET_STATE_INVALID',
    category: 'domain',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'The secret reference is not in a resolvable state.',
    detailSchema: z.object({
      status: z.string().min(1).max(24),
      expectedStatus: z.string().min(1).max(24).optional(),
    }),
  },
  {
    code: 'PUBLICATION_BLOCKED',
    category: 'security',
    httpStatus: 422,
    retryClass: 'no_retry',
    safeMessage: 'Publication was blocked by the leak-scan guard.',
    detailSchema: z.object({
      reasonCode: z.enum(['findings_present', 'scanner_unavailable', 'digest_mismatch']),
      findingCount: z.number().int().nonnegative(),
    }),
  },
  // ---- Perimeter codes (C094) ----
  {
    code: 'WEBHOOK_SIGNATURE_INVALID',
    category: 'security',
    httpStatus: 401,
    retryClass: 'no_retry',
    safeMessage: 'Webhook signature verification failed.',
  },
  {
    code: 'WEBHOOK_DELIVERY_CONFLICT',
    category: 'concurrency',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'Delivery ID was reused with different content.',
    detailSchema: z.object({
      deliveryId: z.string().min(1).max(128),
    }),
  },
  {
    code: 'CSRF_VALIDATION_FAILED',
    category: 'security',
    httpStatus: 403,
    retryClass: 'no_retry',
    safeMessage: 'Request failed CSRF or origin validation.',
  },
  {
    code: 'RATE_LIMITER_UNAVAILABLE',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'safe_retry',
    safeMessage: 'Rate limiting is unavailable; request refused.',
  },
  // ---- Content-safety codes (C095) ----
  {
    code: 'PATH_ACCESS_BLOCKED',
    category: 'security',
    httpStatus: 400,
    retryClass: 'no_retry',
    safeMessage: 'The requested path was blocked by path policy.',
    detailSchema: z.object({ reasonCode: z.string().min(1).max(64) }),
  },
  {
    code: 'ARCHIVE_REJECTED',
    category: 'security',
    httpStatus: 422,
    retryClass: 'no_retry',
    safeMessage: 'Archive was rejected by extraction safety rules.',
    detailSchema: z.object({ reasonCode: z.string().min(1).max(64) }),
  },
  {
    code: 'PATCH_REJECTED',
    category: 'security',
    httpStatus: 422,
    retryClass: 'no_retry',
    safeMessage: 'Patch was rejected by safety validation.',
    detailSchema: z.object({ reasonCode: z.string().min(1).max(64) }),
  },
  {
    code: 'OUTPUT_BUDGET_EXCEEDED',
    category: 'domain',
    httpStatus: 422,
    retryClass: 'no_retry',
    safeMessage: 'Output exceeded its configured budget.',
    detailSchema: z.object({ limitKind: z.string().min(1).max(32) }),
  },
  {
    code: 'ARTIFACT_NOT_SAFE',
    category: 'security',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'Artifact is not in a safe state.',
  },
  {
    code: 'ARTIFACT_EXPIRED',
    category: 'domain',
    httpStatus: 410,
    retryClass: 'no_retry',
    safeMessage: 'Artifact has expired.',
  },
  {
    code: 'ARTIFACT_ACCESS_DENIED',
    category: 'authorization',
    httpStatus: 403,
    retryClass: 'no_retry',
    safeMessage: 'Access to this artifact is not permitted.',
  },
] as const satisfies readonly ErrorDescriptor[];

/** Known foundation codes as a literal union for ergonomic switches. */
export type KnownErrorCode = (typeof FOUNDATION_ERROR_DESCRIPTORS)[number]['code'];

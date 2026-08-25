/**
 * C005 — Versioned /api/v1 transport contracts.
 *
 * Transport-only schemas: envelopes, pagination, cursors, headers, and the
 * four auth endpoint payloads. Resource request/response schemas are composed
 * here by the owning route groups (C065–C075); domain semantics stay in
 * @devguard/contracts.
 */
import { z } from 'zod';

/** Opaque pagination cursor: base64url(JSON {limit, offset}) with hard bounds. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface PageCursorPayload {
  readonly limit: number;
  readonly offset: number;
}

export function encodePageCursor(payload: PageCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodePageCursor(raw: string | undefined): PageCursorPayload {
  const fallback: PageCursorPayload = { limit: DEFAULT_PAGE_SIZE, offset: 0 };
  if (raw === undefined || raw === '') return fallback;
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { limit: -1, offset: -1 }; // invalid marker handled by schema layer
  }
  const result = z
    .object({ limit: z.number().int().min(1).max(MAX_PAGE_SIZE), offset: z.number().int().min(0) })
    .safeParse(parsed);
  return result.success ? result.data : { limit: -1, offset: -1 };
}

export function page<T>(
  items: readonly T[],
  nextOffset: number | undefined,
  effectiveLimit: number = DEFAULT_PAGE_SIZE,
): {
  readonly items: readonly T[];
  readonly nextCursor?: string;
} {
  if (nextOffset === undefined) return { items };
  // The cursor carries the EFFECTIVE limit so pagination state survives across
  // requests instead of silently reverting to the default page size.
  const boundedLimit = Math.min(Math.max(1, effectiveLimit), MAX_PAGE_SIZE);
  return { items, nextCursor: encodePageCursor({ limit: boundedLimit, offset: nextOffset }) };
}

/** Success envelope for JSON responses. */
export interface ApiSuccessEnvelope<T> {
  readonly data: T;
}

/**
 * Error envelope — mirrors @devguard/errors PublicError. Duplicated as a
 * schema so transport validation and frontend decoding share one shape.
 */
export const apiErrorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.string().min(1).max(64),
      message: z.string().max(512),
      requestId: z.string().min(1).max(128),
      details: z.unknown().optional(),
      retryable: z.boolean(),
    })
    .strict(),
});
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

/** Idempotency-Key header (C008-backed use cases consume it unchanged). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** SSE reconnect contract: opaque durable cursor from Last-Event-ID. */
export const LAST_EVENT_ID_HEADER = 'last-event-id';
export const sseCursorSchema = z.string().min(1).max(256);

/** Auth endpoint payload schemas (C005 §11). */
export const authSessionResponseSchema = z
  .object({
    authenticated: z.boolean(),
    user: z
      .object({
        id: z.string().min(1).max(128),
        login: z.string().min(1).max(128),
        displayName: z.string().max(256).optional(),
      })
      .optional(),
    expiresAt: z.string().optional(),
  })
  .strip();
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const authCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(512).optional(),
    state: z.string().min(16).max(256).optional(),
    error: z.string().max(128).optional(),
    error_description: z.string().max(512).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.code !== undefined && value.state !== undefined && value.error === undefined) ||
      value.error !== undefined,
    { message: 'callback must carry either code+state or an error' },
  );

export const loginQuerySchema = z
  .object({
    returnTo: z
      .string()
      .max(256)
      .refine((value) => value.startsWith('/') && !value.startsWith('//'), {
        message: 'returnTo must be a same-site relative path',
      })
      .optional(),
  })
  .strict();

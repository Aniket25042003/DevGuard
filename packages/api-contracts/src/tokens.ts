/**
 * CP004 — CLI/API bearer token endpoint schemas.
 *
 * The raw token (`token`) appears ONLY in the create response, exactly once.
 * List metadata deliberately excludes token hashes and any plaintext (C005
 * "tokens hashed", CP004 §22 security). All boundary objects are `.strict()`.
 */
import { z } from 'zod';

export const apiTokenCreateRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
  })
  .strict();
export type ApiTokenCreateRequest = z.infer<typeof apiTokenCreateRequestSchema>;

export const apiTokenCreateResponseSchema = z
  .object({
    data: z
      .object({
        /** Raw plaintext token — shown exactly once at issuance. */
        token: z.string().min(40).max(256),
        tokenId: z.string().min(1).max(128),
        expiresAt: z.string(),
      })
      .strict(),
  })
  .strict();
export type ApiTokenCreateResponse = z.infer<typeof apiTokenCreateResponseSchema>;

/** One list row — never includes the token hash or plaintext. */
export const apiTokenSummarySchema = z
  .object({
    tokenId: z.string().min(1).max(128),
    label: z.string().min(1).max(64),
    createdAt: z.string(),
    lastUsedAt: z.string().optional(),
    expiresAt: z.string(),
    revokedAt: z.string().optional(),
  })
  .strict();
export type ApiTokenSummary = z.infer<typeof apiTokenSummarySchema>;

export const apiTokenListResponseSchema = z
  .object({ data: z.array(apiTokenSummarySchema) })
  .strict();
export type ApiTokenListResponse = z.infer<typeof apiTokenListResponseSchema>;

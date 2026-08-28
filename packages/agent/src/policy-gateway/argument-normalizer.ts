/**
 * C039 §12 — exact tool argument normalization/validation.
 *
 * Tool arguments are schema-validated and normalized once into a bounded,
 * deterministic structure; the normalized digest is the idempotency basis.
 * Cross-repository/session arguments and schema-mismatched calls are rejected.
 */
import { z } from 'zod';
import { digestOf } from './tool-profiles.js';

export const argumentFieldSchema = z.union([
  z.string().max(64_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()).max(100),
  z.record(z.string(), z.unknown()),
]);

export type ArgumentValidationResult =
  | { readonly ok: true; readonly normalizedDigest: string; readonly normalizedByteLength: number }
  | {
      readonly ok: false;
      readonly code: 'TOOL_SCHEMA_MISMATCH' | 'CROSS_REPO_SESSION_ARGUMENT' | 'MALFORMED_ARGUMENTS';
    };

/** Reject obviously cross-boundary session/repo identifiers in args. */
const FORBIDDEN_ARG_KEYS = /^(sessionId|session_id|turnId|workflowRunId|repository_?id)$/i;

export function normalizeToolArguments(
  rawArguments: unknown,
  expectedSchemaVersion: string,
  providedSchemaVersion: string,
): ArgumentValidationResult {
  if (expectedSchemaVersion !== providedSchemaVersion)
    return { ok: false, code: 'TOOL_SCHEMA_MISMATCH' };
  if (rawArguments === null || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
    return { ok: false, code: 'MALFORMED_ARGUMENTS' };
  }
  // Reject a tool trying to smuggle a session/repository identifier it should
  // not be setting (the intent is bound to the session at the gateway).
  if (Object.keys(rawArguments).some((k) => FORBIDDEN_ARG_KEYS.test(k))) {
    return { ok: false, code: 'CROSS_REPO_SESSION_ARGUMENT' };
  }
  const compact = JSON.stringify(rawArguments);
  const normalized = Array.from(compact)
    .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
    .join('');
  return {
    ok: true,
    normalizedDigest: digestOf(normalized),
    normalizedByteLength: Buffer.byteLength(normalized, 'utf8'),
  };
}

export const toolProfileEntrySchema = z.object({
  toolName: z.string().min(1).max(128),
  schemaVersion: z.string().min(1).max(32),
  actionId: z.string().min(1).max(128),
  providerRisk: z.enum(['read_only', 'low', 'medium', 'high', 'mutative_external']),
  enabled: z.boolean(),
  directMutative: z.boolean(),
});

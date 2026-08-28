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
const FORBIDDEN_ARG_KEYS = /^(sessionId|session_id|turnId|workflowRunId|repository_?id)$/i;
export function normalizeToolArguments(
  rawArguments: unknown,
  expectedSchemaVersion: string,
  providedSchemaVersion: string,
): ArgumentValidationResult {
  if (expectedSchemaVersion !== providedSchemaVersion)
    return { ok: false, code: 'TOOL_SCHEMA_MISMATCH' };
  if (rawArguments === null || typeof rawArguments !== 'object' || Array.isArray(rawArguments))
    return { ok: false, code: 'MALFORMED_ARGUMENTS' };
  const visit = (v: unknown, d: number): boolean => {
    if (d > 16) throw new Error('depth');
    if (Array.isArray(v)) {
      if (v.length > 100) throw new Error('array');
      for (const x of v) if (!visit(x, d + 1)) return false;
    } else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_ARG_KEYS.test(k) || !visit(x, d + 1)) return false;
      }
    else if (typeof v === 'string' && v.length > 64_000) throw new Error('string');
    return true;
  };
  try {
    if (!visit(rawArguments, 0)) return { ok: false, code: 'CROSS_REPO_SESSION_ARGUMENT' };
    const compact = JSON.stringify(rawArguments);
    if (typeof compact !== 'string') return { ok: false, code: 'MALFORMED_ARGUMENTS' };
    const normalized = Array.from(compact)
      .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
      .join('');
    return {
      ok: true,
      normalizedDigest: digestOf(normalized),
      normalizedByteLength: Buffer.byteLength(normalized, 'utf8'),
    };
  } catch {
    return { ok: false, code: 'MALFORMED_ARGUMENTS' };
  }
}
export const toolProfileEntrySchema = z.object({
  profileId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  schemaVersion: z.string().min(1).max(32),
  actionId: z.string().min(1).max(128),
  providerRisk: z.enum(['read_only', 'low', 'medium', 'high', 'mutative_external']),
  enabled: z.boolean(),
  directMutative: z.boolean(),
});

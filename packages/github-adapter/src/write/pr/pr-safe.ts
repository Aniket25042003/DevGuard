/**
 * C021 §17/§20 — content safety + canonical fingerprints for PR operations.
 */
import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical input digest for idempotent operation keys. */
export function mutationInputDigest(input: unknown): string {
  return sha256Hex(canonicalize(input));
}

const SECRET_INLINE =
  /(?:api[-_ .]?key|access[-_ .]?token|refresh[-_ .]?token|token|password|passwd|secret|private[-_ .]?key|credentials)\s*[:=]\s*["']?[^"'\s,;&]{6,}/i;

export function sanitizePrContent(raw: string, max = 256_000): string {
  const normalized = Array.from(raw)
    .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
    .join('');
  const cleaned = normalized.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) throw new Error('GITHUB_PR_CONTENT_EMPTY');
  if (SECRET_INLINE.test(cleaned)) throw new Error('GITHUB_PR_SECRET_REJECTED');
  return cleaned.slice(0, max);
}

export const prSafe = { canonicalize, sha256Hex, mutationInputDigest, sanitizePrContent };

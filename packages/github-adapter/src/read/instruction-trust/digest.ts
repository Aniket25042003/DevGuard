/**
 * C016 — sha256 helpers for snapshots and rejection evidence.
 *
 * Snapshots are digested over canonical, order-stable shapes so idempotent
 * reassembly produces the same digest; duplicate assemblers are rejected by the
 * current-pointer CAS. Content is never stored as authority — only hashes and
 * evidence references (C016 §8/§13).
 */
import { createHash } from 'node:crypto';

/** RFC-8785-style canonical JSON (alphabetical keys, no undefined). */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalize(record[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256, lowercase hex, over UTF-8 bytes. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

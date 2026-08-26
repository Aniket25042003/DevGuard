/**
 * C007 — UUIDv7 generation (ADR-0012).
 *
 * UUIDs are generated application-side in the db package using node:crypto
 * (never by the database), giving time-ordered primary keys without exposing
 * a clock-reading dependency to domain code.
 */
import { randomBytes } from 'node:crypto';

/** RFC 9562 UUIDv7: 48-bit big-endian unix_ts_ms, version 7, variant 10. */
export function uuidv7(now: number = Date.now()): string {
  const timestampMs = BigInt(Math.max(0, Math.floor(now)));
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((timestampMs >> BigInt(8 * (5 - i))) & 0xffn);
  }
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x70; // version 7
  bytes[8] = (b8 & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

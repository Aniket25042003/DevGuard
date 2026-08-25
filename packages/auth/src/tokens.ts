/**
 * C005 — Session token and transaction token cryptography helpers.
 *
 * Raw tokens exist only at the cookie boundary; stores persist SHA-256 hashes.
 * PKCE verifiers use S256. All comparisons over hashes, never raw secrets.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashToken(token: string): string {
  return sha256Hex(`devguard.session.v1:${token}`);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** CSRF proof bound to the session hash and a server secret (double-submit+). */
export function deriveCsrfToken(sessionIdHash: string, serverSecret: string): string {
  return createHash('sha256')
    .update(`devguard.csrf.v1:${sessionIdHash}:${serverSecret}`)
    .digest('base64url');
}

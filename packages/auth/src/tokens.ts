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

/** API token prefix + raw secret, high-entropy; only the hash is persisted. */
export const API_TOKEN_PREFIX = 'dgv1_';

/**
 * Generate a fresh CLI/API token: `dgv1_` + 32 base64url bytes. Returns the
 * plaintext (shown exactly once at issuance) and its SHA-256 hash, derived
 * with a distinct domain separation prefix from session tokens so a raw value
 * can never authenticate on the wrong path.
 */
export function generateApiToken(): {
  readonly plaintext: string;
  readonly tokenHash: string;
} {
  const plaintext = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { plaintext, tokenHash: hashApiToken(plaintext) };
}

export function hashApiToken(plaintext: string): string {
  return sha256Hex(`devguard.api_token.v1:${plaintext}`);
}

/** True when a presented bearer value looks like a DevGuard-issued token. */
export function isApiTokenShape(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length >= 40;
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

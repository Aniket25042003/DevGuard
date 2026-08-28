/**
 * C022 §10/§12/§17 — GitHub webhook HMAC signature verifier.
 *
 * Computes `sha256=HMAC-SHA256(secret, rawBytes)` for each active secret
 * version and compares in constant time. Parsing NEVER precedes verification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SecretVersion {
  readonly version: number;
  readonly secret: string;
}

export interface SecretVersionProvider {
  /** Active secret versions, newest first. */
  active(): Promise<readonly SecretVersion[]>;
}

export class StaticSecretProvider implements SecretVersionProvider {
  constructor(private readonly secrets: readonly SecretVersion[]) {}
  async active(): Promise<readonly SecretVersion[]> {
    return this.secrets;
  }
}

export interface VerificationResult {
  readonly ok: boolean;
  /** Matched secret version (undefined when verification failed). */
  readonly version?: number | undefined;
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class WebhookSignatureVerifier {
  constructor(private readonly provider: SecretVersionProvider) {}

  /**
   * Verify the GitHub `X-Hub-Signature-256: sha256=<hex>` header against the
   * exact raw body bytes. Any active secret version that matches succeeds.
   */
  async verify(rawBytes: Uint8Array, header: string): Promise<VerificationResult> {
    const expected = extractDigest(header);
    if (expected === undefined || !isCanonicalSignatureHeader(header)) return { ok: false };
    const versions = await this.provider.active();
    for (const version of versions) {
      const candidate = createHmac('sha256', version.secret).update(rawBytes).digest();
      if (constantTimeEqual(candidate, Buffer.from(expected, 'hex'))) {
        return { ok: true, version: version.version };
      }
    }
    return { ok: false };
  }
}

/** Parse the `sha256=...` signature header into the raw hex digest. */
export function extractDigest(header: string): string | undefined {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  return match?.[1]?.toLowerCase() as string | undefined;
}

/** Require a canonical header shape (rejects weak/legacy variants). */
export function isCanonicalSignatureHeader(header: string): boolean {
  return /^sha256=[0-9a-fA-F]{64}$/.test(header.trim());
}

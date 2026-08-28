/**
 * C017 §10/§23-3 — App JWT signer.
 *
 * RS256-signed JWT with iss=App ID, iat with 60s backdating, exp=iat+10min
 * (GitHub's documented maximum). Key material arrives through the
 * SecretKeyProvider port; the private key NEVER crosses this module's
 * boundary nor lands in logs (errors carry key VERSION only).
 *
 * Open decision (C017 §28): crypto backend. Node's crypto.sign handles RS256;
 * the module abstracts the key source so KMS/HSM-backed signing can be
 * swapped in without touching callers.
 */
import { createSign } from 'node:crypto';
import { SecretString } from './contracts.js';

export interface AppKeyMaterial {
  /** PEM private key (PKCS#1 or PKCS#8). */
  readonly privateKeyPem: string;
  readonly keyVersion: string;
  readonly appId: string;
}

export interface AppJwtSignerOptions {
  readonly nowMs: () => number;
  /** Backdating window for clock skew (GitHub documents ~60s tolerance). */
  readonly backdateSeconds?: number | undefined;
  /** Lifetime of the JWT (GitHub's max is 10 minutes). */
  readonly lifetimeSeconds?: number | undefined;
}

export interface SignedAppJwt {
  readonly jwt: SecretString;
  readonly expiresAtMs: number;
  readonly keyVersion: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class AppJwtSigner {
  #options: AppJwtSignerOptions;

  constructor(options: AppJwtSignerOptions) {
    this.#options = options;
  }

  sign(key: AppKeyMaterial): SignedAppJwt {
    const nowSeconds = Math.floor(this.#options.nowMs() / 1000);
    const backdate = this.#options.backdateSeconds ?? 60;
    const lifetime = this.#options.lifetimeSeconds ?? 10 * 60;
    if (!Number.isFinite(backdate) || backdate < 0) throw new Error('invalid JWT backdate');
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 600) {
      throw new Error('invalid JWT lifetime');
    }
    const iat = nowSeconds - backdate;
    const exp = iat + lifetime;

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iss: key.appId, iat, exp }));
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(key.privateKeyPem, 'base64url');
    return {
      jwt: new SecretString(`${signingInput}.${signature}`),
      expiresAtMs: exp * 1000,
      keyVersion: key.keyVersion,
    };
  }
}

/** Simple key-material provider that reads from an in-memory source. */
export interface SecretKeyProvider {
  load(): Promise<AppKeyMaterial>;
}

export class InMemoryKeyProvider implements SecretKeyProvider {
  constructor(private readonly material: AppKeyMaterial) {}

  async load(): Promise<AppKeyMaterial> {
    return this.material;
  }
}

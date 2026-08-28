/**
 * C017 §22 — capability mapping, scope digest, JWT claim construction with
 * fake clock, SecretString redaction/non-serialization, token lease lifecycle.
 */
import { describe, expect, it } from 'vitest';
import {
  AppJwtSigner,
  CAPABILITY_PERMISSION_MAP,
  GITHUB_CAPABILITIES,
  InMemoryTokenLeaseCache,
  TokenLeaseManager,
  requiredPermissionsFor,
  scopeDigest,
  secretFrom,
} from '@devguard/github-adapter';

describe('capability-permission registry (C017 §23-2)', () => {
  it('every declared capability has an explicit permission mapping (no guesses)', () => {
    for (const capability of GITHUB_CAPABILITIES) {
      expect(CAPABILITY_PERMISSION_MAP[capability]).toBeDefined();
    }
  });

  it('derives sorted unique minimum permissions for capability sets', () => {
    expect(requiredPermissionsFor(['issue.read', 'content.read'])).toEqual([
      'contents: read',
      'issues: read',
    ]);
  });

  it('unknown capabilities fail closed', () => {
    expect(() => requiredPermissionsFor(['not_a_capability' as never])).toThrow(
      /unknown GitHub capability/,
    );
  });

  it('webhook.receive requires no API permissions', () => {
    expect(CAPABILITY_PERMISSION_MAP['webhook.receive']).toEqual([]);
  });
});

describe('SecretString (C017 §17)', () => {
  it('never leaks values through toString/JSON.stringify/template literals', () => {
    const token = secretFrom('ghs_realtokenvalue123456');
    expect(String(token)).toBe('[REDACTED:github-token]');
    expect(JSON.stringify({ token })).toBe('{"token":"[REDACTED:github-token]"}');
    expect(`${token}`).toBe('[REDACTED:github-token]');
    expect(token.expose()).toBe('ghs_realtokenvalue123456'); // transport-only access
  });

  it('length is safe to report without value exposure', () => {
    expect(secretFrom('abc').isEmpty).toBe(false);
    expect(secretFrom('').isEmpty).toBe(true);
  });
});

// Synthetic RSA key generated at module load for RS256 signing tests.
const { generateKeyPairSync } = await import('node:crypto');
const { privateKey: appTestKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_TEST_PEM = appTestKey.export({ type: 'pkcs1', format: 'pem' }) as string;

describe('AppJwtSigner (C017 §10)', () => {
  const KEY = { privateKeyPem: APP_TEST_PEM, keyVersion: 'v1', appId: '123456' };
  const NOW = 1_700_000_000_000;

  it('signs RS256 JWT with iss/iat/exp claims from the injected clock', () => {
    const signer = new AppJwtSigner({ nowMs: () => NOW });
    const signed = signer.sign(KEY);
    const jwt = signed.jwt.expose();
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(payload['iss']).toBe('123456');
    expect(payload['exp'] - (payload['iat'] as number)).toBe(600);
    expect(payload['iat']).toBeLessThanOrEqual(Math.floor(NOW / 1000));
  });

  it('header declares RS256', () => {
    const signer = new AppJwtSigner({ nowMs: () => NOW });
    const [headerB64] = signer.sign(KEY).jwt.expose().split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(header['alg']).toBe('RS256');
    expect(header['typ']).toBe('JWT');
  });

  it('exposes key version but never key material', () => {
    const signer = new AppJwtSigner({ nowMs: () => NOW });
    const signed = signer.sign(KEY);
    expect(signed.keyVersion).toBe('v1');
    expect(String(signed.jwt)).toBe('[REDACTED:github-token]');
  });
});

describe('TokenLeaseManager (C017 §9/§19/§20)', () => {
  let nowMs = 1_700_000_000_000;

  function makeManager(mintCount = { value: 0 }) {
    const cache = new InMemoryTokenLeaseCache();
    const manager = new TokenLeaseManager(
      cache,
      {
        mint: async () => {
          mintCount.value += 1;
          return {
            token: secretFrom(`ghs_token_${mintCount.value}`),
            expiresAtIso: new Date(nowMs + 3600_000).toISOString(),
          };
        },
      },
      () => nowMs,
    );
    return { manager, cache, mintCount };
  }

  const REPOS = ['11111111', '22222222'];
  const CAPS = ['issue.read', 'content.read'] as const;
  const CRED = 'cred-v1';

  it('caches per (installation, scopeDigest, credentialVersion) and hits cache on second acquire', async () => {
    const { manager, mintCount } = makeManager();
    const first = await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    const second = await manager.acquire('k2', 'inst-1', REPOS, CAPS as never, CRED);
    expect(mintCount.value).toBe(1); // single-flight
    expect(second.token.expose()).toBe(first.token.expose());
  });

  it('different installations never share a cached lease (no cross-tenant coalescing)', async () => {
    const { manager, mintCount } = makeManager();
    await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    await manager.acquire('k1', 'inst-2', REPOS, CAPS as never, CRED);
    expect(mintCount.value).toBe(2);
  });

  it('different repository scopes produce different cache keys', async () => {
    const { manager, mintCount } = makeManager();
    const digestA = scopeDigest(REPOS, CAPS as never);
    const digestB = scopeDigest(['33333333'], CAPS as never);
    expect(digestA).not.toBe(digestB);
    await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    await manager.acquire('k1', 'inst-1', ['33333333'], CAPS as never, CRED);
    expect(mintCount.value).toBe(2);
  });

  it('credential rotation invalidates all cached leases', async () => {
    const { manager, mintCount } = makeManager();
    await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    manager.invalidateAll(); // rotation
    await manager.acquire('k2', 'inst-1', REPOS, CAPS as never, 'cred-v2');
    expect(mintCount.value).toBe(2);
  });

  it('serves cache only before refreshAt; past the window remints', async () => {
    const { manager, mintCount } = makeManager();
    await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    // Advance past expiry minus skew.
    nowMs += 3600_000 - 60_000 + 1;
    await manager.acquire('k2', 'inst-1', REPOS, CAPS as never, CRED);
    expect(mintCount.value).toBe(2);
  });

  it('401 invalidation removes exactly the matching scope', async () => {
    const { manager, mintCount } = makeManager();
    await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    await manager.acquire('k2', 'inst-1', ['33333333'], CAPS as never, CRED);
    manager.invalidate('k1', 'inst-1', REPOS, CAPS as never, CRED);
    await manager.acquire('k3', 'inst-1', REPOS, CAPS as never, CRED);
    expect(mintCount.value).toBe(3);
    // Other scope still cached.
    await manager.acquire('k4', 'inst-1', ['33333333'], CAPS as never, CRED);
    expect(mintCount.value).toBe(3);
  });

  it('scopeDigest on the lease is the computed digest, not the full cache key', async () => {
    const { manager } = makeManager();
    const lease = await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    const expected = scopeDigest(REPOS, CAPS as never);
    expect(lease.scopeDigest).toBe(expected);
    expect(lease.scopeDigest).not.toContain('inst-1');
  });

  it('refreshAtIso reflects the actual refresh window (expiresAt minus skew), not the raw expiry', async () => {
    const { manager } = makeManager();
    const lease = await manager.acquire('k1', 'inst-1', REPOS, CAPS as never, CRED);
    const expiresAtMs = Date.parse(lease.expiresAtIso);
    const refreshAtMs = Date.parse(lease.refreshAtIso);
    expect(expiresAtMs - refreshAtMs).toBe(60_000);
  });
});

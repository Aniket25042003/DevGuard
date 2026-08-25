import { describe, expect, it } from 'vitest';
import {
  EnvelopeEncryptor,
  PublicationGuard,
  ResolvedSecretLease,
  SensitiveDataGuard,
  SecretService,
  staticKeyProvider,
} from '@devguard/security';
import type { SecretRefShape } from '@devguard/security';

function ref(overrides: Partial<SecretRefShape> = {}): SecretRefShape {
  return {
    name: 'GITHUB_APP_PRIVATE_KEY',
    provider: 'environment',
    purpose: 'github_app_key',
    scopeType: 'global',
    scopeId: '*',
    version: 'v1',
    status: 'AVAILABLE',
    ...overrides,
  };
}

const CALLER = {
  callerId: 'worker.test',
  purpose: 'github_app_key',
  scopeType: 'global' as const,
  scopeId: '*',
};

describe('C093 secret resolution', () => {
  it('resolves through the backend into a non-serializable lease', async () => {
    const service = new SecretService({
      backend: {
        get: async (name) =>
          name === 'GITHUB_APP_PRIVATE_KEY' ? 'BEGIN PRIVATE KEY canary-value-1234' : undefined,
      },
    });
    const lease = await service.resolveSecret(ref(), CALLER);
    expect(lease).toBeInstanceOf(ResolvedSecretLease);
    // JSON/toString never leak the value.
    expect(JSON.stringify(lease)).not.toContain('canary');
    expect(String(lease)).toBe('[REDACTED]');
    let seenLength = 0;
    lease.use((value) => {
      seenLength = value.length;
    });
    expect(seenLength).toBeGreaterThan(8);
  });

  it('enforces purpose and scope before touching the backend', async () => {
    let backendHits = 0;
    const service = new SecretService({
      backend: {
        get: async () => {
          backendHits += 1;
          return 'some-secret-value';
        },
      },
    });

    await expect(
      service.resolveSecret(ref(), { ...CALLER, purpose: 'wrong_purpose' }),
    ).rejects.toMatchObject({ code: 'SECRET_ACCESS_DENIED' });

    const repoScoped = ref({ scopeType: 'repository', scopeId: 'repo-a' });
    await expect(
      service.resolveSecret(repoScoped, { ...CALLER, scopeType: 'repository', scopeId: 'repo-b' }),
    ).rejects.toMatchObject({ code: 'SECRET_ACCESS_DENIED' });

    expect(backendHits).toBe(0); // denials happen before any backend access
  });

  it('rejects non-resolvable states and expired references with a fake clock', async () => {
    let nowMs = 1_000_000;
    const service = new SecretService({
      backend: { get: async () => 'a-valid-secret' },
      now: () => new Date(nowMs),
    });

    await expect(service.resolveSecret(ref({ status: 'REVOKED' }), CALLER)).rejects.toMatchObject({
      code: 'SECRET_STATE_INVALID',
    });
    await expect(service.resolveSecret(ref({ status: 'ROTATING' }), CALLER)).rejects.toMatchObject({
      code: 'SECRET_STATE_INVALID',
    });

    const expiring = ref({ expiresAt: new Date(nowMs + 60_000).toISOString() });
    await expect(service.resolveSecret(expiring, CALLER)).resolves.toBeInstanceOf(
      ResolvedSecretLease,
    );

    nowMs += 120_000; // past expiry
    await expect(service.resolveSecret(expiring, CALLER)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });
  });

  it('single-flights concurrent resolutions per reference/version', async () => {
    let backendCalls = 0;
    const service = new SecretService({
      backend: {
        get: async () => {
          backendCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 'concurrent-secret-value';
        },
      },
    });
    const [a, b] = await Promise.all([
      service.resolveSecret(ref(), CALLER),
      service.resolveSecret(ref(), CALLER),
    ]);
    expect(a).toBe(b); // same shared flight
    expect(backendCalls).toBe(1);
  });

  it('withSecret scopes the callback and releases afterwards', async () => {
    const service = new SecretService({ backend: { get: async () => 'scoped-secret-value' } });
    const observed = await service.withSecret(ref(), CALLER, async (value) => value.length);
    expect(observed).toBe('scoped-secret-value'.length);
  });
});

describe('C093 envelope encryption', () => {
  const keys = staticKeyProvider({ v1: 'first-master', v2: 'second-master' });
  const aad = {
    scopeType: 'repository',
    scopeId: 'repo-1',
    purpose: 'github_app_key',
    refVersion: 'v1',
  };

  it('round-trips and binds ciphertext to associated data', async () => {
    const encryptor = new EnvelopeEncryptor(keys, 'v1');
    const record = await encryptor.encrypt('unavoidable-persisted-material', aad);
    expect(record.ciphertextB64).not.toContain('unavoidable');
    expect(record.aadDigest).toMatch(/^[0-9a-f]{64}$/);

    const plaintext = await encryptor.decrypt(record, aad);
    expect(plaintext).toBe('unavoidable-persisted-material');

    await expect(encryptor.decrypt(record, { ...aad, scopeId: 'repo-2' })).rejects.toThrowError(
      /aad_mismatch/,
    );
  });

  it('fails on tampered ciphertext and unknown key versions', async () => {
    const encryptor = new EnvelopeEncryptor(keys, 'v1');
    const record = await encryptor.encrypt('material-2', aad);
    const tampered = { ...record, ciphertextB64: Buffer.from('tampered').toString('base64') };
    await expect(encryptor.decrypt(tampered, aad)).rejects.toThrowError(/decryption_failed/);
    await expect(new EnvelopeEncryptor(keys, 'missing').encrypt('x', aad)).rejects.toThrowError(
      /unknown_key_version/,
    );
  });
});

describe('C093 redaction engine', () => {
  const guard = new SensitiveDataGuard({ hmacKeyHex: 'test-hmac-key' });

  it('redacts nested objects, headers, DSNs, JWTs, PEM blocks and assigned secrets', () => {
    const input = {
      config: {
        token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        notes: 'connect at postgres://admin:hunter2@db.internal:5432/app',
        session: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        keyPem: '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----',
        nested: { deep: { passwordAssignment: "password='sup3rs3cret!'" } },
        safe: 'plain text stays',
      },
    };
    const result = guard.redact(input, 'log');
    const json = JSON.stringify(result.value);
    expect(json).not.toContain('ghp_');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(json).not.toContain('MIIEvQ');
    expect(json).not.toContain('sup3rs3cret');
    expect(json).toContain('plain text stays');
    expect(result.redactionCount).toBeGreaterThanOrEqual(5);
    expect(result.detectorClasses.length).toBeGreaterThan(2);
  });

  it('matches registered exact values even without pattern hits, via keyed fingerprints', () => {
    const canary = 'MYCOMPANY_sk_7f3d9c81b2ea4d5fa1c2e3b4d5f6a7b8';
    const localGuard = new SensitiveDataGuard({ hmacKeyHex: 'exact-key-test' });
    localGuard.registerExactSecret(canary);
    const result = localGuard.redact(`token=${canary}`, 'log');
    expect(JSON.stringify(result.value)).not.toContain(canary);
    expect(result.detectorClasses).toContain('exact_value');
    // Fingerprint is not reversible.
    expect(result.value).not.toContain(localGuard.fingerprintOf(canary));
  });

  it('is stable under repeated redaction and bounds runaway depth', () => {
    const input = { url: 'redis://:secretpw@cache:6379', list: [1, [2, [3]]] };
    const first = JSON.stringify(guard.redact(input, 'log').value);
    const second = JSON.stringify(guard.redact(input, 'log').value);
    expect(first).toBe(second);

    // Deeply-nested hostile input collapses to a redacted field.
    let deep: unknown = 'leaf';
    for (let index = 0; index < 20; index += 1) {
      deep = { child: deep };
    }
    const degradedResult = guard.redact(deep, 'api');
    expect(JSON.stringify(degradedResult.value).length).toBeLessThan(
      JSON.stringify(input).length + 1000,
    );
  });

  it('redacts Error causes recursively without raw fallback', () => {
    const cause = new Error('caused by ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    const error = new Error('wrapper', { cause });
    const projection = guard.redact(error, 'error');
    const projected = projection.value as unknown as {
      message: string;
      cause?: { message?: string };
    };
    expect(projected.message).not.toContain('ghp_');
    expect(JSON.stringify(projected)).not.toContain('ghp_');
  });
});

describe('C093 leak scanning and publication guard', () => {
  const guard = new SensitiveDataGuard({ hmacKeyHex: 'leak-hmac' });
  const publicationGuard = new PublicationGuard(guard);

  it('passes clean diffs and blocks token-bearing patches with fingerprinted findings', async () => {
    const cleanDiff = 'diff --git a/index.ts b/index.ts\n+export const x = 1;\n';
    const cleanScan = await publicationGuard.scanForLeaks('patch', 'run-1-clean', cleanDiff);
    expect(cleanScan.status).toBe('clean');
    publicationGuard.assertPublishable(cleanScan, cleanDiff); // no throw

    const dirtyDiff = `diff --git a/env b/env\n+GITHUB_TOKEN=ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n`;
    const dirtyScan = await publicationGuard.scanForLeaks('patch', 'run-1-dirty', dirtyDiff);
    expect(dirtyScan.status).toBe('findings_present');
    expect(dirtyScan.findings[0]?.detectorClass).toBe('github_token');
    // Findings carry keyed-HMAC fingerprints — never the raw match.
    expect(dirtyScan.findings[0]?.fingerprintHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(() => publicationGuard.assertPublishable(dirtyScan, dirtyDiff)).toThrowError(
      /PUBLICATION_BLOCKED|blocked by the leak-scan/i,
    );
  });

  it('binds the scan to exact bytes: TOCTOU mismatch is blocked', async () => {
    const original = 'safe content for scan';
    const scan = await publicationGuard.scanForLeaks('artifact', 'run-2', original);
    expect(() =>
      publicationGuard.assertPublishable(
        scan,
        `${original}\n+ghp_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD`,
      ),
    ).toThrowError(/digest_mismatch|blocked by the leak-scan/i);
  });

  it('fails closed when the scanner is unavailable', async () => {
    publicationGuard.setScannerAvailability(false);
    const scan = await publicationGuard.scanForLeaks('patch', 'run-3', 'whatever');
    expect(scan.status).toBe('scanner_unavailable');
    expect(() => publicationGuard.assertPublishable(scan, 'whatever')).toThrowError(
      /scanner_unavailable|blocked by the leak-scan/i,
    );
    publicationGuard.setScannerAvailability(true);
  });

  it('registered exact values block publication even in free text', async () => {
    const localGuard = new SensitiveDataGuard({ hmacKeyHex: 'exact-leak' });
    const localPublication = new PublicationGuard(localGuard);
    const canary = 'INTERNAL_canary_ZZZZ9999YYYY';
    localGuard.registerExactSecret(canary);
    const body = `release notes mentioning ${canary} accidentally`;
    const scan = await localPublication.scanForLeaks('pr_body', 'run-4', body);
    expect(scan.status).toBe('findings_present');
    expect(scan.findings[0]?.detectorClass).toBe('exact_value');
  });
});

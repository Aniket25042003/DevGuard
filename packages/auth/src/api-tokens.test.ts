import { describe, expect, it } from 'vitest';
import { ApiTokenService, normalizeTokenLabel } from './api-tokens.js';
import type { ApiTokenRecord, ApiTokenRepository } from './principal.js';
import { generateApiToken, hashApiToken, hashToken, isApiTokenShape } from './tokens.js';

/** Minimal in-memory ApiTokenRepository for service-level unit tests. */
class FakeApiTokenRepository implements ApiTokenRepository {
  readonly rows = new Map<string, ApiTokenRecord>();

  async insert(record: ApiTokenRecord): Promise<void> {
    this.rows.set(record.tokenId, { ...record });
  }

  async findByTokenHash(tokenHash: string): Promise<ApiTokenRecord | undefined> {
    for (const record of this.rows.values()) {
      if (record.tokenHash === tokenHash) return { ...record };
    }
    return undefined;
  }

  async listByOwner(userId: string): Promise<readonly ApiTokenRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...record }));
  }

  async revoke(tokenId: string, userId: string, revokedAt: string): Promise<void> {
    const record = this.rows.get(tokenId);
    if (record !== undefined && record.userId === userId) {
      this.rows.set(tokenId, { ...record, revokedAt, rowVersion: record.rowVersion + 1 });
    }
  }
}

const FIXED_NOW = new Date('2026-08-28T12:00:00.000Z');

function makeService(overrides: Partial<ConstructorParameters<typeof ApiTokenService>[0]> = {}) {
  const tokens = new FakeApiTokenRepository();
  let now = FIXED_NOW;
  const service = new ApiTokenService({
    tokens,
    ownerProfile: { login: 'octo', displayName: 'Octo' },
    now: () => now,
    ...overrides,
  });
  return { service, tokens, advance: (ms: number) => void (now = new Date(now.getTime() + ms)) };
}

describe('generateApiToken / hashApiToken', () => {
  it('produces a prefixed, high-entropy plaintext that differs per call', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.plaintext.startsWith('dgv1_')).toBe(true);
    expect(a.plaintext.length).toBeGreaterThanOrEqual(40);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(isApiTokenShape(a.plaintext)).toBe(true);
  });

  it('hashes deterministically with an api-token domain separation prefix', () => {
    const { plaintext, tokenHash } = generateApiToken();
    expect(tokenHash).toBe(hashApiToken(plaintext));
    expect(tokenHash).not.toBe(hashToken(plaintext));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeTokenLabel', () => {
  it('trims and accepts a valid label', () => {
    expect(normalizeTokenLabel('  my cli  ')).toBe('my cli');
  });

  it('rejects empty, oversized, and control-char labels', () => {
    expect(() => normalizeTokenLabel('')).toThrow();
    expect(() => normalizeTokenLabel('   ')).toThrow();
    expect(() => normalizeTokenLabel('x'.repeat(65))).toThrow();
    expect(() => normalizeTokenLabel('a\u0000b')).toThrow();
    expect(() => normalizeTokenLabel(42 as unknown)).toThrow();
  });
});

describe('ApiTokenService.issue', () => {
  it('issues a token once, returning plaintext plus a stable id and expiry', async () => {
    const { service, tokens } = makeService();
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'ci' });

    expect(issued.token.startsWith('dgv1_')).toBe(true);
    expect(issued.tokenId.length).toBeGreaterThan(0);
    expect(new Date(issued.expiresAt).getTime()).toBe(FIXED_NOW.getTime() + 90 * 24 * 3_600_000);

    const stored = tokens.rows.get(issued.tokenId);
    expect(stored).toBeDefined();
    // The raw token is never persisted — only its hash.
    expect(stored?.tokenHash).toBe(hashApiToken(issued.token));
    expect(stored?.tokenHash).not.toContain(issued.token);
    expect(stored?.userId).toBe('user-1');
  });

  it('honors a custom TTL override', async () => {
    const { service } = makeService({ tokenTtlDays: 7 });
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'short' });
    const delta = new Date(issued.expiresAt).getTime() - FIXED_NOW.getTime();
    expect(delta).toBe(7 * 24 * 3_600_000);
  });
});

describe('ApiTokenService.authenticate', () => {
  it('resolves a valid token into an api_token principal', async () => {
    const { service } = makeService();
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'ci' });
    const principal = await service.authenticate(issued.token);

    expect(principal).toBeDefined();
    expect(principal?.userId).toBe('user-1');
    expect(principal?.authMethod).toBe('api_token');
    expect(principal?.tokenIdHash).toBeDefined();
    expect(principal?.sessionIdHash).toBeUndefined();
    expect(principal?.providerLogin).toBe('octo');
  });

  it('returns undefined for unknown, malformed, and empty credentials', async () => {
    const { service } = makeService();
    expect(await service.authenticate('')).toBeUndefined();
    expect(await service.authenticate('not-an-api-token')).toBeUndefined();
    expect(await service.authenticate('dgv1_' + 'a'.repeat(30))).toBeUndefined();
  });

  it('returns undefined after revocation', async () => {
    const { service } = makeService();
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'revoke-me' });
    await service.revoke(issued.tokenId, 'user-1');
    expect(await service.authenticate(issued.token)).toBeUndefined();
  });

  it('returns undefined after expiry', async () => {
    const { service, tokens } = makeService({ tokenTtlDays: 90, now: () => FIXED_NOW });
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'expiring' });

    // Move "now" past expiry via a second service bound to the same store.
    const later = new Date(FIXED_NOW.getTime() + 91 * 24 * 3_600_000);
    const serviceLater = new ApiTokenService({
      tokens,
      ownerProfile: { login: 'octo' },
      now: () => later,
    });
    expect(await serviceLater.authenticate(issued.token)).toBeUndefined();
  });
});

describe('ApiTokenService.listByOwner / revoke', () => {
  it('lists summaries without ever exposing the token hash or plaintext', async () => {
    const { service, advance } = makeService();
    await service.issue({ ownerUserId: 'user-1', label: 'a' });
    advance(1000);
    await service.issue({ ownerUserId: 'user-1', label: 'b' });
    await service.issue({ ownerUserId: 'user-2', label: 'other' });

    const mine = await service.listByOwner('user-1');
    expect(mine.length).toBe(2);
    for (const summary of mine) {
      expect(summary.tokenId).toBeDefined();
      expect('tokenHash' in summary).toBe(false);
    }
    // newest first
    expect(mine[0]?.label).toBe('b');
  });

  it('revocation is idempotent and scoped to the owner', async () => {
    const { service, tokens } = makeService();
    const issued = await service.issue({ ownerUserId: 'user-1', label: 'mine' });
    await service.revoke(issued.tokenId, 'user-2'); // foreign owner: no-op
    expect(tokens.rows.get(issued.tokenId)?.revokedAt).toBeUndefined();
    await service.revoke(issued.tokenId, 'user-1');
    await service.revoke(issued.tokenId, 'user-1'); // again: still fine
    expect(tokens.rows.get(issued.tokenId)?.revokedAt).toBeDefined();
  });
});

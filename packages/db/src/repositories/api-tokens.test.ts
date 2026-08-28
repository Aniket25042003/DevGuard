/**
 * CP004 §22 — row → record mapping for API tokens without a database, plus
 * revoke SQL scoping checks against a stubbed pool.
 */
import { describe, expect, it } from 'vitest';
import type { DevGuardPool } from '@devguard/db';
import { mapApiTokenRow, PostgresApiTokenRepository } from '@devguard/db';

function poolWith(calls: Array<{ text: string; values: unknown[] }>): DevGuardPool {
  return {
    query: async (input: { text: string; values: unknown[] }) => {
      calls.push({ text: input.text, values: input.values });
      return [] as never[];
    },
    withClient: async <T>(fn: (c: unknown) => Promise<T>) => fn({}),
    health: async () => ({ ok: true, latencyMs: 0, schemaVersion: 8 }),
    drain: async () => undefined,
  } as unknown as DevGuardPool;
}

describe('mapApiTokenRow (CP004 §22)', () => {
  it('maps a live token row (Date timestamps) to the domain record', () => {
    const record = mapApiTokenRow({
      token_id: '7d0f1e15-5a05-4095-a3af-331b6b8ff283',
      user_id: 'user-1',
      token_hash: 'a'.repeat(64),
      label: 'ci',
      created_at: new Date('2026-08-28T00:00:00Z'),
      last_used_at: new Date('2026-08-28T01:00:00Z'),
      expires_at: new Date('2026-11-26T00:00:00Z'),
      revoked_at: null,
      row_version: '0',
    });
    expect(record.tokenId).toBe('7d0f1e15-5a05-4095-a3af-331b6b8ff283');
    expect(record.userId).toBe('user-1');
    expect(record.label).toBe('ci');
    expect(record.lastUsedAt).toBe('2026-08-28T01:00:00.000Z');
    expect(record.revokedAt).toBeUndefined();
    expect(record.rowVersion).toBe(0);
  });

  it('omits nullable columns when null', () => {
    const record = mapApiTokenRow({
      token_id: 'tid',
      user_id: 'u',
      token_hash: 'h',
      label: 'l',
      created_at: '2026-08-28T00:00:00Z',
      last_used_at: null,
      expires_at: '2026-08-28T00:00:00Z',
      revoked_at: null,
      row_version: 1,
    });
    expect(record.lastUsedAt).toBeUndefined();
    expect(record.revokedAt).toBeUndefined();
  });
});

describe('PostgresApiTokenRepository.revoke (CP004 §22)', () => {
  it('scopes the UPDATE to owner + id + still-active, and increments row_version', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const repo = new PostgresApiTokenRepository(poolWith(calls));
    await repo.revoke('tid', 'user-1', '2026-08-28T00:00:00Z');
    expect(calls.length).toBe(1);
    expect(calls[0]?.values).toEqual(['tid', 'user-1', '2026-08-28T00:00:00Z']);
    expect(calls[0]?.text).toContain('WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL');
    expect(calls[0]?.text).toContain('row_version = row_version + 1');
  });
});

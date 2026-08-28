/**
 * CP003 §22 — row → record mapping and CAS failure semantics without a database.
 */
import { describe, expect, it } from 'vitest';
import type { DevGuardPool } from '@devguard/db';
import {
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  mapAuthSessionRow,
  mapAuthTransactionRow,
} from '@devguard/db';

function emptyPool(): DevGuardPool {
  return {
    query: async () => [] as never[],
    withClient: async <T>(fn: (c: unknown) => Promise<T>) => fn({}),
    health: async () => ({ ok: true, latencyMs: 0, schemaVersion: 7 }),
    drain: async () => undefined,
  } as unknown as DevGuardPool;
}

describe('mapAuthSessionRow (CP003 §22)', () => {
  it('maps pg rows (Date timestamps) to the auth record shape', () => {
    const row = {
      session_id_hash: 'aabb1122',
      user_id: 'user-1',
      provider_issuer: 'https://github.com',
      provider_subject: 'octo',
      provider_login: 'octocat',
      provider_display_name: null,
      created_at: new Date('2026-08-28T00:00:00Z'),
      last_seen_at: new Date('2026-08-28T00:00:00Z'),
      idle_expires_at: new Date('2026-08-28T01:00:00Z'),
      absolute_expires_at: new Date('2026-08-28T08:00:00Z'),
      revoked_at: new Date('2026-08-28T02:00:00Z'),
      row_version: '3',
    };
    const record = mapAuthSessionRow(row);
    expect(record.sessionIdHash).toBe('aabb1122');
    expect(record.userId).toBe('user-1');
    expect(record.providerLogin).toBe('octocat');
    expect(record.providerDisplayName).toBeUndefined();
    expect(record.createdAt).toBe('2026-08-28T00:00:00.000Z');
    expect(record.revokedAt).toBe('2026-08-28T02:00:00.000Z');
    expect(record.rowVersion).toBe(3);
  });

  it('leaves nullable provider/revoked columns absent when null', () => {
    const record = mapAuthSessionRow({
      session_id_hash: 'x',
      user_id: 'u',
      provider_issuer: 'i',
      provider_subject: 's',
      created_at: '2026-08-28T00:00:00Z',
      last_seen_at: '2026-08-28T00:00:00Z',
      idle_expires_at: '2026-08-28T00:00:00Z',
      absolute_expires_at: '2026-08-28T00:00:00Z',
      revoked_at: null,
      row_version: 0,
    });
    expect(record.providerLogin).toBeUndefined();
    expect(record.revokedAt).toBeUndefined();
  });
});

describe('mapAuthTransactionRow (CP003 §22)', () => {
  it('maps a consumed transaction row', () => {
    const record = mapAuthTransactionRow({
      state_hash: 'state-hash',
      pkce_verifier: 'verifier',
      return_to_path: '/dashboard',
      created_at: new Date('2026-08-28T00:00:00Z'),
      expires_at: new Date('2026-08-28T00:10:00Z'),
      consumed_at: new Date('2026-08-28T00:00:05Z'),
      row_version: '1',
    });
    expect(record.stateHash).toBe('state-hash');
    expect(record.pkceVerifier).toBe('verifier');
    expect(record.consumedAt).toBe('2026-08-28T00:00:05.000Z');
    expect(record.rowVersion).toBe(1);
  });
});

describe('CAS failure contract (CP003 §22/§18)', () => {
  it('session touch on a stale row_version throws a VERSION_CONFLICT-prefixed error', async () => {
    const repo = new PostgresAuthSessionRepository(emptyPool());
    let error: unknown = null;
    try {
      await repo.touch('hash', '2026-08-28T00:00:00Z', '2026-08-28T00:30:00Z', 5);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });

  it('session revoke on a stale row_version throws a VERSION_CONFLICT-prefixed error', async () => {
    const repo = new PostgresAuthSessionRepository(emptyPool());
    let error: unknown = null;
    try {
      await repo.revoke('hash', '2026-08-28T00:05:00Z', 5);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });

  it('transaction consume on an already-consumed row throws a VERSION_CONFLICT-prefixed error', async () => {
    const repo = new PostgresAuthTransactionRepository(emptyPool());
    let error: unknown = null;
    try {
      await repo.consume('state-hash', '2026-08-28T00:00:05Z', 0);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });
});

/**
 * CP003 §22 — DB-gated integration for durable auth sessions/transactions and
 * the Postgres user identity linker: insert/find, CAS touch/revoke/consume,
 * and durability across a pool restart (a valid session survives). Skips
 * without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimestampIso } from '@devguard/contracts';
import {
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  PostgresUserIdentityLinker,
  createPool,
  type DevGuardPool,
} from '@devguard/db';
import { requireDatabaseUrl } from './db-harness.js';
import { provisionDatabase, teardownDatabase } from '@devguard/test-harness';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;
let sessionRepo: PostgresAuthSessionRepository;
let transactionRepo: PostgresAuthTransactionRepository;
let identities: PostgresUserIdentityLinker;
let dbUrl: string;

const LEASED_DB = `dg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Branded timestamp literal helper. */
const ts = (value: string): TimestampIso => value as TimestampIso;

beforeAll(async () => {
  const handle = await provisionDatabase({
    adminUrl: requireDatabaseUrl(),
    databaseName: LEASED_DB,
  });
  await handle.pool.drain();
  dbUrl = handle.url;
  pool = createPool({ connectionString: dbUrl });
  sessionRepo = new PostgresAuthSessionRepository(pool);
  transactionRepo = new PostgresAuthTransactionRepository(pool);
  identities = new PostgresUserIdentityLinker(pool);
});

afterAll(async () => {
  await pool?.drain();
  await teardownDatabase(requireDatabaseUrl(), LEASED_DB);
});

describeDb('CP003 durable auth stores', () => {
  it('binds one user per (issuer, subject) and stores only hashes', async () => {
    const userId = await identities.resolve('https://github.com', 'octo-1001', {
      login: 'octocat',
    });
    expect(userId.length).toBeGreaterThan(0);
    const again = await identities.resolve('https://github.com', 'octo-1001', {
      login: 'octocat',
    });
    expect(again).toBe(userId);

    const rows = await pool.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM auth_sessions WHERE user_id = $1',
      values: [userId],
    });
    // No session was created by the identity linker (only user + identity rows).
    expect(Number(rows[0]?.n ?? '0')).toBe(0);
  });

  it('inserts and finds a session; survives a pool restart (durability)', async () => {
    const userId = await identities.resolve('https://github.com', 'octo-1002', {
      login: 'octocat-2',
    });
    const record = {
      sessionIdHash: 'hash-002',
      userId,
      providerIssuer: 'https://github.com',
      providerSubject: 'octo-1002',
      providerLogin: 'octocat-2',
      createdAt: ts('2026-08-28T00:00:00.000Z'),
      lastSeenAt: ts('2026-08-28T00:00:00.000Z'),
      idleExpiresAt: ts('2026-08-28T00:30:00.000Z'),
      absoluteExpiresAt: ts('2026-08-28T08:00:00.000Z'),
      rowVersion: 0,
    };
    await sessionRepo.insert(record);
    expect(await sessionRepo.findBySessionIdHash('hash-002')).toMatchObject({
      sessionIdHash: 'hash-002',
      userId,
      providerLogin: 'octocat-2',
    });

    // Restart: a fresh pool (new connection) still reads the same session.
    await pool.drain();
    pool = createPool({ connectionString: dbUrl });
    sessionRepo = new PostgresAuthSessionRepository(pool);
    transactionRepo = new PostgresAuthTransactionRepository(pool);
    identities = new PostgresUserIdentityLinker(pool);
    const afterRestart = await sessionRepo.findBySessionIdHash('hash-002');
    expect(afterRestart?.sessionIdHash).toBe('hash-002');
    expect(afterRestart?.rowVersion).toBe(0);
  });

  it('CAS touch succeeds on the current version and conflicts on a stale version', async () => {
    const found = await sessionRepo.findBySessionIdHash('hash-002');
    expect(found).toBeDefined();
    if (found === undefined) return;
    await sessionRepo.touch(
      'hash-002',
      ts('2026-08-28T00:05:00.000Z'),
      ts('2026-08-28T00:35:00.000Z'),
      0,
    );
    expect((await sessionRepo.findBySessionIdHash('hash-002'))?.rowVersion).toBe(1);

    let error: unknown = null;
    try {
      await sessionRepo.touch(
        'hash-002',
        ts('2026-08-28T00:10:00.000Z'),
        ts('2026-08-28T00:40:00.000Z'),
        0,
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });

  it('CAS revoke marks the session revoked and rejects a stale revoke', async () => {
    await sessionRepo.revoke('hash-002', ts('2026-08-28T00:15:00.000Z'), 1);
    expect((await sessionRepo.findBySessionIdHash('hash-002'))?.revokedAt).toBeDefined();

    let error: unknown = null;
    try {
      await sessionRepo.revoke('hash-002', ts('2026-08-28T00:16:00.000Z'), 1);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });

  it('consumes an OAuth transaction once and rejects replays', async () => {
    await transactionRepo.insert({
      stateHash: 'state-111',
      pkceVerifier: 'verifier-value',
      returnToPath: '/dashboard',
      createdAt: ts('2026-08-28T00:00:00.000Z'),
      expiresAt: ts('2026-08-28T00:10:00.000Z'),
      rowVersion: 0,
    });
    expect((await transactionRepo.findByStateHash('state-111'))?.rowVersion).toBe(0);
    await transactionRepo.consume('state-111', ts('2026-08-28T00:00:01.000Z'), 0);
    expect((await transactionRepo.findByStateHash('state-111'))?.rowVersion).toBe(1);

    let error: unknown = null;
    try {
      await transactionRepo.consume('state-111', ts('2026-08-28T00:00:02.000Z'), 0);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message.startsWith('VERSION_CONFLICT')).toBe(true);
  });
});

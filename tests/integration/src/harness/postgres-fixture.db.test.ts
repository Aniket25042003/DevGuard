/**
 * C096 §13 / C098 §8 — DB-gated PostgreSQL fixture integration.
 * Provisions a leased database, verifies migrations from zero and truncation.
 * Skips without DEGUARD_TEST_DATABASE_URL (service-backed CI runs it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionDatabase, teardownDatabase, truncateAll } from '@devguard/test-harness';

const ADMIN_URL = process.env.DEGUARD_TEST_DATABASE_URL;
const DB_NAME = `dg_fixture_${Math.random().toString(16).slice(2, 8)}`;
const describeDb = ADMIN_URL ? describe : describe.skip;

let handle: Awaited<ReturnType<typeof provisionDatabase>> | undefined;

beforeAll(async () => {
  if (!ADMIN_URL) return;
  handle = await provisionDatabase({ adminUrl: ADMIN_URL, databaseName: DB_NAME });
});

afterAll(async () => {
  await handle?.pool.drain();
  if (ADMIN_URL) await teardownDatabase(ADMIN_URL, DB_NAME);
});

describeDb('C096 postgres fixture', () => {
  it('applies every migration from zero inside the lease', async () => {
    expect(handle?.appliedMigrations.length).toBeGreaterThan(0);
    const pool = handle!.pool;
    const rows = await pool.query<{ name: string }>({
      text: 'SELECT name FROM schema_migrations ORDER BY version',
    });
    expect(rows.length).toBe(handle!.appliedMigrations.length);
  });

  it('truncateAll clears user tables but preserves migration bookkeeping', async () => {
    const pool = handle!.pool;
    // Any durable user table works; use one created by C009+ migrations if present.
    const tables = (
      await pool.query<{ tablename: string }>({
        text: `SELECT tablename FROM pg_tables WHERE schemaname='public'
               AND tablename NOT IN ('schema_migrations','migration_failures') LIMIT 1`,
      })
    ).map((r) => r.tablename);
    await truncateAll(pool);
    for (const table of tables) {
      const count = await pool.query<{ n: string }>({
        text: `SELECT count(*)::text AS n FROM "${table}"`,
      });
      expect(Number(count[0]?.n)).toBe(0);
    }
    const migrations = await pool.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM schema_migrations',
    });
    expect(Number(migrations[0]?.n)).toBeGreaterThan(0);
  });

  it('creates uniquely-named leased databases across sequential provisions', async () => {
    if (!ADMIN_URL) return;
    const otherName = `dg_fixture_${Math.random().toString(16).slice(2, 8)}`;
    const second = await provisionDatabase({ adminUrl: ADMIN_URL, databaseName: otherName });
    expect(otherName === DB_NAME).toBe(false);
    await second.pool.drain();
    const torn = await teardownDatabase(ADMIN_URL, otherName);
    expect(torn.dropped).toBe(true);
  });
});

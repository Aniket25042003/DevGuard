/**
 * C096 §13 — PostgreSQL fixture support.
 *
 * Decision recorded for C096 §28 ("schema-per-worker versus
 * database-per-worker"): **database-per-worker** was chosen because the C007
 * migration runner assumes ownership of `public` in its target database and
 * existing DB suites reset that schema; nesting schemas inside one database
 * would fight that contract and risks cross-worker leakage through shared
 * advisory-lock keys.
 *
 * Invariants:
 * - Migrations always run from zero against the leased database.
 * - Truncate happens only inside the lease; teardown drops the database.
 * - Failures during setup raise TEST_INFRASTRUCTURE so suites report
 *   infrastructure failure instead of false product failure (C096 §18).
 */
import type { DevGuardPool } from '@devguard/db';
import { createPool, runMigrations } from '@devguard/db';
import { makeError } from '@devguard/errors';

export interface PostgresFixtureOptions {
  /** Root/admin connection URL to a disposable PostgreSQL server. */
  readonly adminUrl: string;
  /** Leased database name from ResourceLeaseManager (dg_...). */
  readonly databaseName: string;
  /** Skip automatic from-zero migrations (suites that own the lifecycle). */
  readonly skipMigrations?: boolean;
}

export interface PostgresFixtureHandle {
  readonly url: string;
  readonly pool: DevGuardPool;
  /** Versions applied by the harness; empty when skipMigrations was set. */
  readonly appliedMigrations: readonly number[];
}

export function assertDisposablePostgres(adminUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw makeError('TEST_INFRASTRUCTURE', { details: undefined });
  }
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/(test|disposable|_dg|dg_)/i.test(db) && !parsed.searchParams.has('disposable')) {
    throw new Error(
      `Refusing destructive harness operations on non-disposable database '${db}'. ` +
        'Name the test database with a "test"/"disposable"/"dg" marker.',
    );
  }
}

function deriveUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function terminateAndDrop(pool: DevGuardPool, databaseName: string): Promise<void> {
  await pool.query({
    text: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    values: [databaseName],
  });
  await pool.query({ text: `DROP DATABASE IF EXISTS "${databaseName}"` });
}

/** Create a fresh leased database, apply all migrations from zero, expose a pool. */
export async function provisionDatabase(
  options: PostgresFixtureOptions,
): Promise<PostgresFixtureHandle> {
  assertDisposablePostgres(options.adminUrl);
  if (!/^[A-Za-z0-9_]{1,63}$/.test(options.databaseName)) {
    throw new Error(`Invalid leased database name '${options.databaseName}'`);
  }
  const adminPool = createPool({ connectionString: options.adminUrl, max: 2 });
  try {
    await terminateAndDrop(adminPool, options.databaseName);
    await adminPool.query({ text: `CREATE DATABASE "${options.databaseName}"` });
  } catch (error) {
    await adminPool.drain().catch(() => undefined);
    throw error instanceof Error ? error : makeError('TEST_INFRASTRUCTURE');
  } finally {
    // The admin pool only exists to CREATE/DROP; all fixtures use the derived URL.
    await adminPool.drain().catch(() => undefined);
  }

  const url = deriveUrl(options.adminUrl, options.databaseName);
  const fixturePool = createPool({ connectionString: url, max: 5 });
  try {
    if (options.skipMigrations) {
      return { url, pool: fixturePool, appliedMigrations: [] };
    }
    const result = await runMigrations(fixturePool);
    return { url, pool: fixturePool, appliedMigrations: result.applied };
  } catch (error) {
    await fixturePool.drain().catch(() => undefined);
    throw error;
  }
}

/** Truncate every user table inside the lease between cases (order-independent). */
export async function truncateAll(pool: DevGuardPool): Promise<void> {
  const rows = await pool.query<{ statement: string }>({
    text: `
      SELECT format('TRUNCATE TABLE %I.%I CASCADE', schemaname, tablename) AS statement
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_migrations', 'migration_failures')`,
  });
  for (const row of rows) {
    await pool.query({ text: row.statement });
  }
}

export async function teardownDatabase(
  adminUrl: string,
  databaseName: string,
): Promise<{ dropped: boolean }> {
  assertDisposablePostgres(adminUrl);
  if (!/^[A-Za-z0-9_]{1,63}$/.test(databaseName)) return { dropped: false };
  const adminPool = createPool({ connectionString: adminUrl, max: 1 });
  try {
    await terminateAndDrop(adminPool, databaseName);
    return { dropped: true };
  } finally {
    await adminPool.drain().catch(() => undefined);
  }
}

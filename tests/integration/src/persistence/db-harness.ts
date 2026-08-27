/**
 * Shared harness for DB-gated persistence tests.
 *
 * These suites run only when DEGUARD_TEST_DATABASE_URL points at a disposable
 * PostgreSQL database (C096/C098 provision one in CI). The URL target is
 * treated as ephemeral: migrations.db.test.ts resets the public schema.
 */
import { createPool, type DevGuardPool } from '@devguard/db';

export const TEST_DATABASE_URL = process.env['DEGUARD_TEST_DATABASE_URL'] ?? '';

/** Gate per the PR-007 brief: DB-gated suites skip silently without a database. */
export function requireDatabaseUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('DEGUARD_TEST_DATABASE_URL is not set');
  return TEST_DATABASE_URL;
}

export function createTestPool(): DevGuardPool {
  return createPool({
    connectionString: requireDatabaseUrl(),
    max: 5,
    statementTimeoutMs: 15_000,
  });
}

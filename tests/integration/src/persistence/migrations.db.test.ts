/**
 * C007 §22 — DB-gated integration: apply from zero, idempotent re-run,
 * checksum refusal, dirty-state gate, and health schemaVersion.
 * Skips without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSchemaCompatible,
  createPool,
  loadMigrationSources,
  parseMigrations,
  resolveMigrationsDir,
  runMigrations,
  type DevGuardPool,
} from '@devguard/db';
import { DevGuardError } from '@devguard/errors';
import { TEST_DATABASE_URL } from './db-harness.js';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DATABASE_URL, max: 3 });
  // The gated target is disposable by contract (C007 §20 test isolation).
  await pool.query({ text: 'DROP SCHEMA public CASCADE' });
  await pool.query({ text: 'CREATE SCHEMA public' });
});

afterAll(async () => {
  await pool?.drain();
});

describeDb('C007 migration runner', () => {
  it('applies all packaged migrations from zero in one locked run', async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([1, 2]);
    const rows = await pool.query<{ version: string }>({
      text: 'SELECT version::text AS version FROM schema_migrations ORDER BY version',
    });
    expect(rows.map((row) => Number(row.version))).toEqual([1, 2]);
    expect(await assertSchemaCompatible(pool)).toBeUndefined();
  });

  it('reports the applied schema version through health()', async () => {
    const status = await pool.health();
    expect(status.ok).toBe(true);
    expect(status.schemaVersion).toBe(2);
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('re-runs idempotently without replaying applied migrations', async () => {
    const again = await runMigrations(pool);
    expect(again.applied).toEqual([]);
    expect(again.verified).toEqual([1, 2]);
  });

  it('refuses a tampered checksum on an applied migration', async () => {
    await pool.query({
      text: "UPDATE schema_migrations SET checksum = repeat('ab', 32) WHERE version = 1",
    });
    let caught: unknown;
    try {
      await runMigrations(pool);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DevGuardError);
    expect((caught as DevGuardError).code).toBe('MIGRATION_CHECKSUM_MISMATCH');
    // Restore recorded checksums so later suites share a healthy database.
    const migrations = parseMigrations(
      loadMigrationSources(process.env['DEVGUARD_DB_MIGRATIONS_DIR'] ?? resolveMigrationsDir()),
    );
    for (const migration of migrations) {
      await pool.query({
        text: 'UPDATE schema_migrations SET checksum = $1 WHERE version = $2',
        values: [migration.checksum, migration.version],
      });
    }
    expect((await runMigrations(pool)).applied).toEqual([]);
  });

  it('blocks startup while the schema is dirty and recovers when cleared', async () => {
    await pool.query({
      text: "INSERT INTO migration_failures (version, name, error_code) VALUES (2, 'idempotency_outbox', '42P16') ON CONFLICT (version) DO UPDATE SET error_code = EXCLUDED.error_code",
    });
    let caught: unknown;
    try {
      await assertSchemaCompatible(pool);
    } catch (error) {
      caught = error;
    }
    expect((caught as DevGuardError)?.code).toBe('SCHEMA_INCOMPATIBLE');
    await pool.query({ text: 'DELETE FROM migration_failures' });
    expect(await assertSchemaCompatible(pool)).toBeUndefined();
  });
});

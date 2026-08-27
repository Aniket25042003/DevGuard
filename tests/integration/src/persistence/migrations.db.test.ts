// IMPORTANT: these tests require DEGUARD_TEST_DATABASE_URL pointing at a
// disposable database, NOT a shared instance.
// They destructively reset the public schema (C007 §20 test isolation).
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
import { provisionDatabase, teardownDatabase } from '@devguard/test-harness';
import { requireDatabaseUrl } from './db-harness.js';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;

const LEASED_DB = `dg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  // C096 isolation: every DB-gated suite owns a leased database so parallel
  // workers cannot observe each other's migrations or fixtures.
  const handle = await provisionDatabase({
    adminUrl: requireDatabaseUrl(),
    databaseName: LEASED_DB,
    // This suite owns the migration lifecycle and needs a virgin database.
    skipMigrations: true,
  });
  await handle.pool.drain();
  pool = createPool({ connectionString: handle.url, max: 3 });
});

afterAll(async () => {
  await pool?.drain();
  await teardownDatabase(requireDatabaseUrl(), LEASED_DB);
});

describeDb('C007 migration runner', () => {
  it('applies all packaged migrations from zero in one locked run', async () => {
    // Expected set derives from the packaged files (C007 §22): appending a
    // migration must not require editing this suite.
    const expected = parseMigrations(loadMigrationSources(resolveMigrationsDir()))
      .map((migration) => migration.version)
      .sort((a, b) => a - b);
    const result = await runMigrations(pool);
    expect(result.applied).toEqual(expected);
    const rows = await pool.query<{ version: string }>({
      text: 'SELECT version::text AS version FROM schema_migrations ORDER BY version',
    });
    expect(rows.map((row) => Number(row.version))).toEqual(expected);
    expect(await assertSchemaCompatible(pool)).toBeUndefined();
  });

  it('reports the applied schema version through health()', async () => {
    const status = await pool.health();
    expect(status.ok).toBe(true);
    expect(status.schemaVersion).toBeGreaterThanOrEqual(6);
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('re-runs idempotently without replaying applied migrations', async () => {
    const again = await runMigrations(pool);
    expect(again.applied).toEqual([]);
    expect(again.applied).toEqual([]);
    expect(again.verified.length).toBeGreaterThan(0);
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

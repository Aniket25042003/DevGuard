/**
 * C007 — Migration runner: advisory-locked, ordered, checksummed application.
 *
 * Contract (C007 §9/§20):
 * - One migrator at a time via `pg_advisory_lock(hashtext('devguard_migrations'))`
 *   held on a single dedicated client for the whole run.
 * - Each pending `.sql` file applies in its own transaction; transactional DDL
 *   rolls back atomically on failure and the failure is recorded durably
 *   (`migration_failures`) so restarts refuse to proceed until an operator
 *   clears the dirty state.
 * - Applied migrations are never re-run; recorded checksums must match the
 *   local files exactly (MIGRATION_CHECKSUM_MISMATCH otherwise).
 */
import type { PoolClient } from 'pg';
import { makeError } from '@devguard/errors';
import type { DevGuardPool } from '../pool.js';
import { sqlStateOf } from '../sql.js';
import {
  loadMigrationSources,
  parseMigrations,
  planMigrations,
  resolveMigrationsDir,
} from './list.js';

const LOCK_STATEMENT = "SELECT pg_advisory_lock(hashtext('devguard_migrations'))";
const UNLOCK_STATEMENT = "SELECT pg_advisory_unlock(hashtext('devguard_migrations'))";

const ENSURE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version bigint PRIMARY KEY,
  name text NOT NULL UNIQUE,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  execution_ms integer NOT NULL
)`;

/** Durable dirty-state marker written outside the failed migration transaction. */
const ENSURE_MIGRATION_FAILURES = `
CREATE TABLE IF NOT EXISTS migration_failures (
  version bigint PRIMARY KEY,
  name text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  error_code text NOT NULL
)`;

export interface MigrationRunOptions {
  /** Explicit migrations directory; defaults to the packaged location. */
  readonly dir?: string;
}

export interface MigrationRunResult {
  readonly applied: number[];
  readonly verified: number[];
}

interface AppliedRow {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
}

/** Apply pending migrations. Safe to run concurrently across processes/replicas. */
export async function runMigrations(
  pool: DevGuardPool,
  options?: MigrationRunOptions,
): Promise<MigrationRunResult> {
  const dir = options?.dir ?? resolveMigrationsDir();
  const migrations = parseMigrations(loadMigrationSources(dir));

  return pool.withClient(async (client) => {
    await client.query(LOCK_STATEMENT);
    try {
      await client.query(ENSURE_SCHEMA_MIGRATIONS);
      await client.query(ENSURE_MIGRATION_FAILURES);

      const applied = (
        await client.query<AppliedRow>(
          'SELECT version::text AS version, name, checksum FROM schema_migrations ORDER BY version',
        )
      ).rows;
      const failures = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM migration_failures',
      );
      if (Number(failures.rows[0]?.n ?? '0') > 0) {
        throw makeError('MIGRATION_DIRTY', {
          details: { version: Number(applied.at(-1)?.version ?? '0') },
        });
      }

      const { verified, toApply } = planMigrations(migrations, applied);
      for (const migration of toApply) {
        await applyMigration(client, migration);
      }
      return {
        applied: toApply.map((migration) => migration.version),
        verified: verified.map((migration) => migration.version),
      };
    } finally {
      await client.query(UNLOCK_STATEMENT);
    }
  });
}

async function applyMigration(
  client: PoolClient,
  migration: {
    version: number;
    name: string;
    checksum: string;
    sql: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  await client.query('BEGIN');
  try {
    // Multi-statement files run via the simple query protocol inside one tx.
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, Date.now() - startedAt],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection-level failure: the open transaction dies with the session.
    }
    // Record the dirty state outside the rolled-back transaction.
    await client.query(
      `INSERT INTO migration_failures (version, name, error_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (version) DO UPDATE SET attempted_at = now(), error_code = EXCLUDED.error_code`,
      [migration.version, migration.name, sqlStateOf(error) ?? 'UNKNOWN'],
    );
    throw makeError('MIGRATION_DIRTY', {
      cause: error,
      details: { version: migration.version },
    });
  }
}

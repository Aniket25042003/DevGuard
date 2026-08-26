/**
 * C007 — Startup schema-compatibility gate (§23 step 9).
 *
 * The app refuses an unsupported schema instead of running against a
 * half-migrated or dirty database: applied versions must be contiguous from 1
 * and no failed migration may be pending operator recovery.
 */
import { makeError } from '@devguard/errors';
import type { DevGuardPool } from './pool.js';
import { sqlStateOf } from './sql.js';

export async function assertSchemaCompatible(pool: DevGuardPool): Promise<void> {
  let versions: number[];
  try {
    const rows = await pool.query<{ version: string }>({
      text: 'SELECT version::text AS version FROM schema_migrations ORDER BY version',
    });
    versions = rows.map((row) => Number(row.version));
  } catch (error) {
    if (sqlStateOf(error) === '42P01') {
      throw incompatible('schema_migrations is missing; run migrations first', error);
    }
    throw error;
  }

  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== index + 1) {
      throw incompatible(
        `applied migration versions are not contiguous (found ${versions.join(', ')})`,
      );
    }
  }

  const failures = await pool.query<{ n: string }>({
    text: 'SELECT count(*)::text AS n FROM migration_failures',
  });
  if (Number(failures[0]?.n ?? '0') > 0) {
    throw incompatible('database has recorded migration failures (dirty state)');
  }
}

function incompatible(reason: string, cause?: unknown): Error {
  return makeError('SCHEMA_INCOMPATIBLE', { details: { reason }, cause });
}

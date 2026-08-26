/**
 * C007 — Migration metadata: filename parsing, sha256 checksums, and pure
 * apply planning. The planning core is side-effect free so it can be tested
 * without a database (in-memory fake runners) per C007 §22.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeError } from '@devguard/errors';

export interface MigrationSource {
  readonly fileName: string;
  readonly content: string;
}

export interface ParsedMigration {
  readonly version: number;
  readonly name: string;
  /** sha256 hex of the raw file content; applied migrations are immutable. */
  readonly checksum: string;
  readonly sql: string;
}

/** Row shape of `schema_migrations` as seen by the planner. */
export interface AppliedMigrationRow {
  readonly version: number | bigint | string;
  readonly name: string;
  readonly checksum: string;
}

const FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

/** sha256 hex digest of UTF-8 content — the migration immutability key. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Parse and order migration sources. Fails closed on malformed names,
 * duplicate versions, and version gaps (sequence must start at 1).
 */
export function parseMigrations(sources: readonly MigrationSource[]): ParsedMigration[] {
  const byVersion = new Map<number, ParsedMigration>();
  for (const source of sources) {
    const match = FILE_PATTERN.exec(source.fileName);
    if (!match) {
      throw new TypeError(
        `Migration file '${source.fileName}' must be named NNN_name.sql (NNN = zero-padded version).`,
      );
    }
    const version = Number(match[1]);
    const name = match[2] ?? '';
    if (byVersion.has(version)) {
      throw new TypeError(`Duplicate migration version ${version} in '${source.fileName}'.`);
    }
    byVersion.set(version, {
      version,
      name,
      checksum: sha256Hex(source.content),
      sql: source.content,
    });
  }

  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  if (versions.length > 0 && versions[0] !== 1) {
    throw new TypeError(
      `Migrations must start at version 1; first file is version ${versions[0]}.`,
    );
  }
  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== index + 1) {
      throw new TypeError(`Migration versions must be contiguous; gap before ${versions[index]}.`);
    }
  }
  return versions.map((version) => byVersion.get(version) as ParsedMigration);
}

export interface MigrationPlan {
  /** Applied rows whose name/checksum match the local sources, in version order. */
  readonly verified: ParsedMigration[];
  /** Pending migrations to apply, in version order. */
  readonly toApply: ParsedMigration[];
}

/**
 * Compare local sources against the applied registry. Throws
 * MIGRATION_CHECKSUM_MISMATCH when an applied row's checksum or name differs —
 * applied SQL is immutable and changed content must ship as a new migration.
 */
export function planMigrations(
  migrations: readonly ParsedMigration[],
  applied: readonly AppliedMigrationRow[],
): MigrationPlan {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const version = Number(row.version);
    const local = byVersion.get(version);
    if (!local || local.name !== row.name || local.checksum !== row.checksum) {
      throw makeError('MIGRATION_CHECKSUM_MISMATCH', {
        cause: new Error(
          `Applied migration ${version} (${row.name}) does not match local file ` +
            `(expected checksum ${local?.checksum ?? '<missing>'}, recorded ${row.checksum}).`,
        ),
        details: { version, name: row.name },
      });
    }
  }
  const appliedVersions = new Set(applied.map((row) => Number(row.version)));
  return {
    verified: migrations.filter((migration) => appliedVersions.has(migration.version)),
    toApply: migrations.filter((migration) => !appliedVersions.has(migration.version)),
  };
}

/**
 * Resolve the packaged migrations directory. `tsc` does not copy `.sql`
 * assets into `dist`, so candidates cover both source and compiled layouts,
 * with `DEVGUARD_DB_MIGRATIONS_DIR` as the explicit override.
 */
export function resolveMigrationsDir(): string {
  const candidates: Array<string | undefined> = [
    process.env['DEVGUARD_DB_MIGRATIONS_DIR'],
    fileURLToPath(new URL('.', import.meta.url)), // running from src/migrations
    fileURLToPath(new URL('../../src/migrations', import.meta.url)), // compiled dist/migrations
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const entries = readdirSync(candidate);
      if (entries.some((entry) => entry.endsWith('.sql'))) return candidate;
    } catch {
      // Try the next candidate layout.
    }
  }
  throw new Error(
    'Unable to locate DevGuard SQL migrations directory; set DEVGUARD_DB_MIGRATIONS_DIR.',
  );
}

/** Read `.sql` sources from a directory, sorted by file name. */
export function loadMigrationSources(dir: string): MigrationSource[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((fileName) => ({ fileName, content: readFileSync(`${dir}/${fileName}`, 'utf8') }));
}

/**
 * C007 §22 — Always-run unit tests: migration list parsing, checksum
 * computation, and apply planning against an in-memory fake runner. No
 * database required; the real runner consumes the same pure planning core.
 */
import { describe, expect, it } from 'vitest';
import {
  parseMigrations,
  planMigrations,
  sha256Hex,
  type AppliedMigrationRow,
  type MigrationSource,
} from '@devguard/db';
import { DevGuardError } from '@devguard/errors';

const SOURCES: MigrationSource[] = [
  { fileName: '002_second.sql', content: 'CREATE TABLE b(id int);' },
  { fileName: '001_first.sql', content: 'CREATE TABLE a(id int);' },
];

describe('C007 migration list parsing', () => {
  it('parses versions/names, orders by version, and computes stable sha256 checksums', () => {
    const parsed = parseMigrations(SOURCES);
    expect(parsed.map((migration) => migration.version)).toEqual([1, 2]);
    expect(parsed[0]?.name).toBe('first');
    expect(parsed[1]?.name).toBe('second');
    expect(parsed[0]?.checksum).toBe(sha256Hex(SOURCES[1]?.content ?? ''));
  });

  it('rejects malformed file names', () => {
    expect(() =>
      parseMigrations([{ fileName: 'migrations.sql', content: '-- no version' }]),
    ).toThrow(/NNN_name\.sql/);
  });

  it('rejects duplicate versions', () => {
    expect(() =>
      parseMigrations([
        { fileName: '001_a.sql', content: 'a' },
        { fileName: '001_b.sql', content: 'b' },
      ]),
    ).toThrow(/Duplicate migration version 1/);
  });

  it('rejects version gaps and sequences not starting at 1', () => {
    expect(() => parseMigrations([{ fileName: '002_gap.sql', content: 'x' }])).toThrow(
      /start at version 1/,
    );
    const gapped = [
      { fileName: '001_a.sql', content: 'a' },
      { fileName: '003_c.sql', content: 'c' },
    ];
    expect(() => parseMigrations(gapped)).toThrow(/contiguous/);
  });
});

/** In-memory fake runner applying exactly what planMigrations authorizes. */
function fakeRunner(sources: MigrationSource[]) {
  const migrations = parseMigrations(sources);
  return function run(applied: AppliedMigrationRow[]): AppliedMigrationRow[] {
    const plan = planMigrations(migrations, applied);
    return [
      ...applied,
      ...plan.toApply.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      })),
    ];
  };
}

describe('C007 migration planning against a fake runner', () => {
  const run = fakeRunner(SOURCES);

  it('applies everything in order from zero', () => {
    const applied = run([]);
    expect(applied.map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it('applies only pending migrations on restart', () => {
    const applied = run([
      { version: 1, name: 'first', checksum: sha256Hex(SOURCES[1]?.content ?? '') },
    ]);
    expect(applied.map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it('is idempotent once fully applied', () => {
    const once = run([]);
    expect(run(once).map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it('refuses changed checksums on applied files with MIGRATION_CHECKSUM_MISMATCH', () => {
    const tampered: AppliedMigrationRow[] = [
      { version: 1, name: 'first', checksum: 'deadbeef'.repeat(8) },
    ];
    let caught: unknown;
    try {
      run(tampered);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DevGuardError);
    expect((caught as DevGuardError).code).toBe('MIGRATION_CHECKSUM_MISMATCH');
  });

  it('refuses applied rows unknown to the local sources', () => {
    const foreign: AppliedMigrationRow[] = [
      { version: 9, name: 'ghost', checksum: 'x'.repeat(64) },
    ];
    expect(() => run(foreign)).toThrow(DevGuardError);
  });

  it('refuses applied names that disagree with local files at the same version', () => {
    const renamed: AppliedMigrationRow[] = [
      { version: 1, name: 'renamed_after_release', checksum: sha256Hex(SOURCES[1]?.content ?? '') },
    ];
    expect(() => run(renamed)).toThrow(DevGuardError);
  });
});

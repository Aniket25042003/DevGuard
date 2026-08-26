#!/usr/bin/env node
/**
 * CI/dev entrypoint for service-backed integration suites (C096/C098).
 *
 * Requires disposable PostgreSQL via DEGUARD_TEST_DATABASE_URL. When unset,
 * defaults to the C098 test-services stack (`pnpm test:services:up`) so local
 * and CI share one code path. Never points at non-disposable databases.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_TEST_DB =
  'postgres://devguard_test:devguard_test_local@127.0.0.1:25432/devguard_test';

const url = process.env.DEGUARD_TEST_DATABASE_URL ?? DEFAULT_TEST_DB;
if (!/(test|disposable|_dg|dg_)/i.test(url)) {
  console.error(
    'DEGUARD_TEST_DATABASE_URL must reference a disposable database (name contains "test"/"disposable"/"dg").',
  );
  process.exit(2);
}

const build = spawnSync('pnpm', ['exec', 'tsc', '-b', 'tsconfig.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'unit'], {
  stdio: 'inherit',
  env: { ...process.env, DEGUARD_TEST_DATABASE_URL: url },
});
process.exit(result.status ?? 1);

#!/usr/bin/env node
/**
 * Production-safe migration runner (C007).
 *
 * Applies pending SQL migrations via @devguard/db. Unlike local.mjs, this does
 * not assert a disposable database name — it is intended for Render pre-deploy
 * hooks and one-shot migration jobs.
 */
import { existsSync } from 'node:fs';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    console.error(JSON.stringify({ status: 'failed', reason: 'DATABASE_URL is required' }));
    process.exitCode = 1;
    return;
  }

  const dbModuleUrl = new URL('../../packages/db/dist/index.js', import.meta.url);
  if (!existsSync(dbModuleUrl)) {
    console.error(
      JSON.stringify({
        status: 'failed',
        reason: '@devguard/db is not built; run pnpm build before migrate',
      }),
    );
    process.exitCode = 1;
    return;
  }

  const { createPool, runMigrations } = await import(dbModuleUrl.href);
  const pool = createPool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await runMigrations(pool);
    console.log(
      JSON.stringify({
        status: 'passed',
        applied: result.applied,
        verified: result.verified,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.drain();
  }
}

main();

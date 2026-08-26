/**
 * C098 §22 — unit tests for local-orchestration helpers.
 *
 * Repo convention (see architecture/boundaries.test.ts): tooling/scripts stay
 * plain .mjs outside every tsconfig root, so these suites drive them through
 * spawned node subprocesses and assert on their JSON output/exit codes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = path.join(REPO_ROOT, 'scripts/local/lib/env.mjs');

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run an async expression in a subprocess where `envLib` is the imported lib. */
function runWithLib(body: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as envLib from ${JSON.stringify(new URL(`file://${LIB}`).href)};
         const result = await (${body})(envLib);
         if (result !== undefined) console.log(JSON.stringify(result));`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: `${e.stderr ?? ''}${e.message ?? ''}`,
    };
  }
}

describe('parseDotEnv', () => {
  it('parses key=value pairs, comments, blank lines and quotes', () => {
    const run = runWithLib(
      `(m) => m.parseDotEnv([
        '# comment', '',
        'DEVGUARD_ENV=development',
        'DATABASE_URL=postgres://u:p@127.0.0.1:15432/devguard',
        'QUOTED="with spaces"',
        "SINGLE='single'",
        'BAD LINE WITHOUT EQUALS',
        '=NOKEY'
      ].join('\\n'))`,
    );
    expect(run.ok).toBe(true);
    const parsed = JSON.parse(run.stdout) as Record<string, string>;
    expect(parsed['DEVGUARD_ENV']).toBe('development');
    expect(parsed['DATABASE_URL']).toBe('postgres://u:p@127.0.0.1:15432/devguard');
    expect(parsed['QUOTED']).toBe('with spaces');
    expect(parsed['SINGLE']).toBe('single');
    expect(Object.keys(parsed)).toHaveLength(4);
  });
});

describe('bootstrapEnv (C098 §20 create-if-absent)', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dg-env-'));
    writeFileSync(
      path.join(dir, '.env.example'),
      'DEVGUARD_ENV=development\nDATABASE_URL=\nREDIS_URL=\nAUTH_GITHUB_OAUTH_CLIENT_ID=\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates .env.local once with local defaults; never overwrites developer edits', () => {
    const first = runWithLib(`(m) => m.bootstrapEnv(${JSON.stringify(dir)})`);
    expect(first.ok).toBe(true);
    const created = JSON.parse(first.stdout) as { created: boolean; path: string };
    expect(created.created).toBe(true);

    const content = readFileSync(created.path, 'utf8');
    expect(content).toContain('DATABASE_URL=postgres://devguard_admin');
    expect(content).toContain('REDIS_URL=redis://127.0.0.1:16379');
    // Provider slots stay empty placeholders; no token-shaped values (C093).
    expect(content).toContain('AUTH_GITHUB_OAUTH_CLIENT_ID=');
    expect(content).not.toMatch(/gh[pousr]_[A-Za-z0-9]{10,}/);

    writeFileSync(created.path, `${content}# developer edit\n`, { flag: 'a' });
    const second = runWithLib(`(m) => m.bootstrapEnv(${JSON.stringify(dir)})`);
    expect(second.ok).toBe(true);
    const rerun = JSON.parse(second.stdout) as { created: boolean };
    expect(rerun.created).toBe(false);
    // Idempotency: developer edits survive.
    expect(readFileSync(created.path, 'utf8')).toContain('# developer edit');
  });
});

describe('assertLocalDisposableTarget (C098 §17 reset safety)', () => {
  it('accepts loopback URLs and dev/test-marked names', () => {
    for (const target of [
      'postgres://a:b@127.0.0.1:15432/devguard',
      'devguard_test',
      'devguard-local_pgdata',
    ]) {
      const run = runWithLib(
        `async (m) => { m.assertLocalDisposableTarget(${JSON.stringify(target)}); return true; }`,
      );
      expect(run.ok, run.stderr).toBe(true);
    }
  });

  it('rejects remote hosts and unmarked names with actionable errors', () => {
    const remote = runWithLib(
      `(m) => { throw m.assertLocalDisposableTarget('postgres://a:b@db.internal.corp/prod'); }`,
    );
    expect(remote.ok).toBe(false);
    expect(remote.stderr).toMatch(/non-local host/);

    const unmarked = runWithLib(
      `(m) => { throw m.assertLocalDisposableTarget('analytics_production'); }`,
    );
    expect(unmarked.ok).toBe(false);
    expect(unmarked.stderr).toMatch(/identity marker/);
  });
});

describe('summarizePrerequisites', () => {
  it('aggregates failed checks into an actionable summary', () => {
    const run = runWithLib(
      `(m) => m.summarizePrerequisites([
        { name: 'node', ok: true },
        { name: 'docker', ok: false, detail: 'command not found' },
        { name: 'compose', ok: false, detail: 'missing' }
      ])`,
    );
    expect(run.ok).toBe(true);
    const result = JSON.parse(run.stdout) as { ok: boolean; summary: string };
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('docker: command not found');
    expect(result.summary).toContain('compose: missing');

    const healthy = runWithLib(`(m) => m.summarizePrerequisites([{ name: 'node', ok: true }])`);
    expect((JSON.parse(healthy.stdout) as { ok: boolean }).ok).toBe(true);
  });
});

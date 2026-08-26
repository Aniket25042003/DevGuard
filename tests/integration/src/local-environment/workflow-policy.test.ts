/**
 * C099 §22 — workflow-policy gate tests.
 *
 * Drives scripts/ci/check-workflow-policy.mjs through a node subprocess
 * (repo convention: CI tooling stays outside tsconfig roots) and asserts the
 * committed workflows pass while hostile fixtures fail closed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GATE = path.join(REPO_ROOT, 'scripts/ci/check-workflow-policy.mjs');

function runGate(args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
    };
  }
}

describe('workflow policy gate (C099)', () => {
  it('passes on the committed repository workflows', () => {
    const run = runGate();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('workflow-policy: OK');
  });

  it('fails closed with an actionable message for unpinned actions', () => {
    const tmp = runInTempWorkflow([
      'name: hostile\n',
      'permissions:\n  contents: read\n',
      'jobs:\n',
      '  x:\n',
      '    - uses: actions/checkout@v5\n',
      '    timeout-minutes: 10\n',
    ]);
    const run = runGate([tmp]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unpinned action/);
  });

  it('fails for missing permissions block and missing job timeouts', () => {
    const tmp = runInTempWorkflow([
      'name: hostile2\n',
      'jobs:\n',
      '  x:\n',
      `    - uses: actions/checkout@${'a'.repeat(40)}\n`,
    ]);
    const run = runGate([tmp]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/missing top-level 'permissions:' block/);
    expect(run.stderr).toMatch(/job 'x' lacks a timeout-minutes value/);
  });
});

/** Write a synthetic workflow tree and return its directory path. */
let tempRoot: string | undefined;

function runInTempWorkflow(lines: string[]): string {
  tempRoot ??= mkdtempSync(path.join(tmpdir(), 'dg-wfpolicy-'));
  const dir = path.join(tempRoot, `workflows-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'hostile.yml'), lines.join(''));
  return dir;
}

process.on('exit', () => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

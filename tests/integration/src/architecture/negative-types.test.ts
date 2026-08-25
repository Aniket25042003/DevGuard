import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtureDir = path.join(repoRoot, 'tooling/fixtures/negative');

function runNegativeTypecheck(): string {
  try {
    execFileSync(path.join(repoRoot, 'node_modules/.bin/tsc'), ['--noEmit', '-p', fixtureDir], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return '';
}

describe('C001 strict TypeScript negative fixtures', () => {
  it('fails to compile when strictness is violated', () => {
    const output = runNegativeTypecheck();
    expect(output, 'negative fixtures must not compile cleanly').toMatch(/error TS\d+/);
  });

  it('rejects deep imports across package boundaries', () => {
    const output = runNegativeTypecheck();
    expect(output).toMatch(/deep-import\.ts/);
    expect(output).toMatch(/@devguard\/errors\/src/);
  });

  it('proves noUncheckedIndexedAccess is active (TS2532)', () => {
    const output = runNegativeTypecheck();
    expect(output).toMatch(/TS2532/);
  });

  it('proves exactOptionalPropertyTypes is active (TS2375/TS2379)', () => {
    const output = runNegativeTypecheck();
    expect(output).toMatch(/TS2375|TS2379/);
  });
});

/**
 * CP013 §23/§25 — no package may spawn host processes. TrueForge owns execution;
 * DevGuard only talks to it over HTTP. This scans every package source file.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('Host-execution architecture (CP013)', () => {
  it('no package source imports node:child_process or spawns host processes', async () => {
    const root = resolve(process.cwd());
    const packagesDir = join(root, 'packages');
    const files = await listTsFiles(packagesDir);
    expect(files.length).toBeGreaterThan(0);
    const offenders: Array<{ file: string; line: string }> = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line) => {
        // Only flag ACTUAL process spawning/imports, not `RegExp.exec()` or the
        // literal string `'exec'`/`bundle exec` inside detection rules.
        if (
          /node:child_process|\bchild_process\b|\b(execSync|spawnSync|execFileSync|fork)\s*\(|(?<!\.)\b(execFile|exec|spawn)\s*\(/.test(
            line,
          ) &&
          !line.trim().startsWith('*') &&
          !line.trim().startsWith('//')
        ) {
          const rel = file.slice(packagesDir.length + 1);
          if (!/\.test\.ts$/.test(rel)) offenders.push({ file: rel, line: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

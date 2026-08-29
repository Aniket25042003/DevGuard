import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) acc.push(full);
  }
  return acc;
}

describe('C089 boundary', () => {
  it('keeps /api/v1 URL construction inside lib/api', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const offenders: string[] = [];
    for (const file of walk(root)) {
      if (file.endsWith('next.config.ts')) continue;
      if (file.includes(`${path.sep}lib${path.sep}api${path.sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes("'/api/v1") || text.includes('`/api/v1') || text.includes('"/api/v1')) {
        if (file.includes(`${path.sep}features${path.sep}auth${path.sep}`)) {
          // Callback redirects the GitHub code to the existing API callback.
          continue;
        }
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

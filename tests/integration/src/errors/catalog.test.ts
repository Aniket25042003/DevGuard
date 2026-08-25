import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listErrorDescriptors } from '@devguard/errors';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalogPath = path.join(repoRoot, 'docs/architecture/error-code-catalog.md');

describe('C003 error-code catalog sync', () => {
  it('documents every registered code exactly once', () => {
    const catalog = readFileSync(catalogPath, 'utf8');
    const documented = new Set(
      [...catalog.matchAll(/^\| ([A-Z][A-Z0-9_]+) +\|/gm)].map((match) => match[1] ?? ''),
    );
    const registered = listErrorDescriptors().map((descriptor) => descriptor.code);
    for (const code of registered) {
      expect(documented.has(code), `code ${code} missing from catalog`).toBe(true);
    }
    for (const code of documented) {
      expect(registered.includes(code), `catalog row ${code} is not registered`).toBe(true);
    }
  });
});

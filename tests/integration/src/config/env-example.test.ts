import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIELD_INVENTORY } from '@devguard/config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const exampleContent = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

/** Extract NAME=… lines (ignoring comments). */
function exampleEntries(): Array<{ name: string; value: string }> {
  return exampleContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return { name: line.slice(0, index), value: line.slice(index + 1) };
    });
}

describe('C002 .env.example parity and safety', () => {
  it('lists every registered field', () => {
    const names = new Set(exampleEntries().map((entry) => entry.name));
    for (const fieldDef of FIELD_INVENTORY) {
      expect(names.has(fieldDef.name), `missing ${fieldDef.name}`).toBe(true);
    }
  });

  it('registers every listed name in the schema', () => {
    for (const entry of exampleEntries()) {
      expect(
        FIELD_INVENTORY.some((fieldDef) => fieldDef.name === entry.name),
        `unregistered example variable ${entry.name}`,
      ).toBe(true);
    }
  });

  it('never contains populated secret values', () => {
    const secrets = FIELD_INVENTORY.filter((fieldDef) => fieldDef.secrecy === 'secret');
    for (const secretField of secrets) {
      const line = exampleEntries().find((entry) => entry.name === secretField.name);
      expect(line?.value ?? '', `${secretField.name} must stay empty`).toBe('');
    }
  });

  it('classifies every field with owner, processes, secrecy, and description', () => {
    for (const fieldDef of FIELD_INVENTORY) {
      expect(fieldDef.owner).toMatch(/^C\d+$/);
      expect(fieldDef.processes.length).toBeGreaterThan(0);
      expect(['public', 'internal', 'secret']).toContain(fieldDef.secrecy);
      expect(fieldDef.description.length).toBeGreaterThan(5);
    }
    // Secrecy classification sanity: connection strings are secrets.
    expect(FIELD_INVENTORY.find((f) => f.name === 'DATABASE_URL')?.secrecy).toBe('secret');
    expect(FIELD_INVENTORY.find((f) => f.name === 'PUBLIC_API_BASE_URL')?.secrecy).toBe('public');
  });
});

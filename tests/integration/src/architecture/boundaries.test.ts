import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function loadMatrix(): {
  layers: Record<string, string[]>;
  packages: Record<string, string>;
  packageScope: string;
} {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'tooling/boundaries/boundary-matrix.json'), 'utf8'),
  );
}

describe('C001 boundary matrix integrity', () => {
  const matrix = loadMatrix();

  it('declares only the fixed layer vocabulary', () => {
    const allowedLayers = new Set([
      'app',
      'application',
      'domain',
      'port',
      'adapter',
      'persistence',
      'ui',
      // Tooling-only pseudo-layer for verification suites; never shipped.
      'test',
    ]);
    for (const layer of Object.keys(matrix.layers)) {
      expect(allowedLayers.has(layer), `unknown layer '${layer}'`).toBe(true);
    }
  });

  it('only allows declared may-depend-on layers', () => {
    for (const [layer, mayDependOn] of Object.entries(matrix.layers)) {
      for (const target of mayDependOn) {
        expect(
          matrix.layers[target],
          `layer '${layer}' depends on undeclared layer '${target}'`,
        ).toBeDefined();
      }
    }
  });

  it('keeps domain layers free of downstream dependencies', () => {
    expect(matrix.layers['domain']).toEqual(['domain']);
  });

  it('never allows depending on app/ui composition shells from below', () => {
    for (const [layer, mayDependOn] of Object.entries(matrix.layers)) {
      if (layer === 'app' || layer === 'test') continue;
      expect(mayDependOn).not.toContain('app');
      expect(mayDependOn).not.toContain('ui');
    }
  });

  it('registers every existing workspace package (fail closed)', () => {
    const registered = new Set(Object.keys(matrix.packages));
    const discovered = discoverPackages(repoRoot);
    expect(discovered.sort()).toEqual([...registered].sort());
  });
});

describe('C001 package manifest conventions', () => {
  it('exposes exactly one public entry point per package', () => {
    for (const pkg of Object.keys(loadMatrix().packages)) {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, pkg, 'package.json'), 'utf8'));
      expect(manifest.type, `${pkg} must be ESM`).toBe('module');
      const exportKeys = Object.keys(manifest.exports ?? {}).filter(
        (key) => key !== './package.json',
      );
      // Importable packages expose exactly one public entry; bare test suites may expose none.
      if (exportKeys.length > 0) {
        expect(exportKeys, `${pkg} must export only '.'`).toEqual(['.']);
      }
    }
  });
});

describe('C001 deep-import prevention', () => {
  it('has no cross-package /src/ deep imports in sources', () => {
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        scan(path.join(dir, entry.name));
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          const file = path.join(dir, entry.name);
          const content = readFileSync(file, 'utf8');
          const matches = content.matchAll(/from\s+'(@devguard\/[^']+)'/g);
          for (const match of matches) {
            const specifier = match[1];
            if (
              specifier !== undefined &&
              /@devguard\/[^/]+\/(?!package\.json).+/.test(specifier)
            ) {
              offenders.push(`${file}: ${specifier}`);
            }
          }
        }
      }
    };
    for (const base of ['apps', 'packages', 'tests']) {
      const abs = path.join(repoRoot, base);
      if (existsSync(abs)) scan(abs);
    }
    expect(offenders).toEqual([]);
  });
});

describe('C001 boundary checker wiring', () => {
  it('rejects a fixture project that violates its declared layer matrix', () => {
    const fixtureRoot = path.join(repoRoot, 'tooling/fixtures/boundary');
    expect(() =>
      execFileSync(
        'node',
        [
          path.join(repoRoot, 'scripts/check-boundaries.mjs'),
          '--fixture',
          fixtureRoot,
          '--matrix',
          path.join(fixtureRoot, 'matrix.json'),
        ],
        {
          stdio: 'pipe',
          encoding: 'utf8',
        },
      ),
    ).toThrowError(/layer-application-cannot-depend|Boundary violation/i);
  });

  it('passes on the real workspace when invoked directly', () => {
    const stdout = execFileSync('node', [path.join(repoRoot, 'scripts/check-boundaries.mjs')], {
      stdio: 'pipe',
      encoding: 'utf8',
      cwd: repoRoot,
    });
    expect(stdout).toContain('check-boundaries: OK');
  });
});

function discoverPackages(root: string): string[] {
  const found: string[] = [];
  for (const base of ['apps', 'packages', 'tests']) {
    const baseAbs = path.join(root, base);
    if (!existsSync(baseAbs)) continue;
    const visit = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const child = path.join(dir, entry.name);
        if (existsSync(path.join(child, 'package.json'))) {
          found.push(path.relative(root, child));
        } else {
          visit(child);
        }
      }
    };
    visit(baseAbs);
  }
  return found;
}

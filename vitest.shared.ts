import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * In-repo package aliases: '@devguard/<name>' resolves straight to source so
 * tests never require a prior build. The exports maps still point at dist for
 * any out-of-repo consumer, and deep imports stay impossible because only the
 * bare entry names are aliased.
 */
function buildAliases() {
  const aliases = {};
  const roots = ['packages', 'apps'];
  for (const base of roots) {
    const baseAbs = path.join(repoRoot, base);
    if (!existsSync(baseAbs)) continue;
    const visit = (dir) => {
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
        const manifestPath = path.join(child, 'package.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if (manifest.name) {
              aliases[manifest.name] = path.join(child, 'src/index.ts');
            }
          } catch {
            // Malformed manifests fail the boundary gate instead.
          }
        }
        visit(child);
      }
    };
    visit(baseAbs);
  }
  return aliases;
}

export default {
  test: {
    environment: 'node',
    globals: false,
    restoreMocks: true,
    reporters: ['default'],
    passWithNoTests: false,
  },
  resolve: {
    alias: buildAliases(),
  },
};

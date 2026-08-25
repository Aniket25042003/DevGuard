#!/usr/bin/env node
/**
 * DevGuard dependency-boundary gate (C001 §23 step 10).
 *
 * 1. Discovers every workspace package (fail closed on unregistered packages).
 * 2. Validates manifests declare a single public entry point.
 * 3. Runs dependency-cruiser with rules generated from the declared matrix.
 *
 * Usage:
 *   node scripts/check-boundaries.mjs [--fixture <root>] [--matrix <path>]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const fixtureRoot = argValue('--fixture');
const rootDir = fixtureRoot ? path.resolve(fixtureRoot) : process.cwd();
const { loadMatrix, buildCruiseOptions } = await import(
  new URL(`../tooling/boundaries/boundaries.mjs`, import.meta.url)
);

const matrixPath = argValue('--matrix');
const matrix = matrixPath
  ? JSON.parse(readFileSync(path.resolve(matrixPath), 'utf8'))
  : loadMatrix(process.cwd());

/** Walk candidate roots and collect directories containing package.json. */
function discoverWorkspacePackages(base) {
  const roots = ['apps', 'packages', 'tests'];
  const found = [];
  for (const root of roots) {
    const rootAbs = path.join(base, root);
    if (!existsSync(rootAbs)) continue;
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const child = path.join(dir, entry.name);
        const manifest = path.join(child, 'package.json');
        if (existsSync(manifest)) {
          found.push({ dir: path.relative(base, child), manifest });
        } else {
          visit(child);
        }
      }
    };
    visit(rootAbs);
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`✗ ${message}`);
};

if (matrix.rules.failClosedUnregisteredPackages && !fixtureRoot) {
  const discovered = discoverWorkspacePackages(process.cwd());
  const registered = Object.keys(matrix.packages);
  for (const pkg of discovered) {
    if (!registered.includes(pkg.dir)) {
      fail(
        `Unregistered workspace package '${pkg.dir}'. Register it in tooling/boundaries/boundary-matrix.json before it may import or be imported.`,
      );
    }
  }
  for (const registeredPath of registered) {
    if (!existsSync(path.join(process.cwd(), registeredPath))) {
      fail(`Registered package '${registeredPath}' does not exist in the workspace.`);
    }
  }
}

// Manifest sanity: scope + single public entry point (no deep exports).
for (const [pkgPath] of Object.entries(matrix.packages)) {
  const manifestFile = path.join(process.cwd(), pkgPath, 'package.json');
  if (!existsSync(manifestFile)) continue;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const expectedScope = `${matrix.packageScope}/`;
  if (!String(manifest.name ?? '').startsWith(expectedScope)) {
    fail(
      `${pkgPath}: package name must live under the '${matrix.packageScope}' scope (found '${manifest.name}').`,
    );
  }
  if (manifest.type !== 'module') {
    fail(`${pkgPath}: ESM ('type': 'module') is required.`);
  }
  const exportsMap = manifest.exports;
  const exportKeys = exportsMap
    ? Object.keys(exportsMap).filter((k) => k !== './package.json')
    : [];
  if (exportKeys.length > 1 || (exportKeys.length === 1 && exportKeys[0] !== '.')) {
    fail(
      `${pkgPath}: packages may expose at most the single public entry point '.' (found: ${exportKeys.join(', ')}).`,
    );
  }
}

// Run the cruise gate programmatically over the fixture or real workspace.
const { cruise } = await import('dependency-cruiser');
const sourceRoots = fixtureRoot
  ? ['src']
  : ['apps', 'packages', 'tests'].filter((dir) => existsSync(path.join(rootDir, dir)));
const options = buildCruiseOptions(matrix);
if (fixtureRoot) {
  // Fixture lives outside a package context: resolve modules and rules relative to itself.
  options.tsConfig = undefined;
  options.baseDir = rootDir;
}
const cruiseResult = await cruise(sourceRoots, options);
const violations = cruiseResult.output.modules.flatMap((module) =>
  module.dependencies
    .filter((dependency) => dependency.valid === false)
    .map((dependency) => ({
      from: module.source,
      to: dependency.resolved ?? dependency.coreModule,
      rule: Array.isArray(dependency.rules)
        ? dependency.rules.map((rule) => rule.name).join(',')
        : 'unknown',
    })),
);

for (const violation of violations) {
  fail(`Boundary violation [${violation.rule}]: ${violation.from} -> ${violation.to}`);
}

if (failures > 0) {
  console.error(`\ncheck-boundaries: ${failures} violation(s).`);
  process.exit(1);
}
console.log('check-boundaries: OK — declared dependency matrix holds.');

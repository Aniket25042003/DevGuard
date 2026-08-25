/**
 * Boundary-rule generator shared by scripts/check-boundaries.mjs, the
 * dependency-cruiser gate, and architecture tests.
 *
 * The invariant (C001 §6):
 *   transport/UI → application service → domain/authorization logic → repository/provider port
 * Provider SDK types and SQL row types terminate at adapters; nothing imports the app layer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadMatrix(rootDir = process.cwd()) {
  const matrixPath = path.join(rootDir, 'tooling/boundaries/boundary-matrix.json');
  return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function packagePathRegex(packagePath) {
  return `^${escapeRegex(packagePath)}(/|$)`;
}

/**
 * Build dependency-cruiser `forbidden` rules from the declared matrix.
 * Unknown target packages fail closed via the unregistered-package rule.
 */
export function buildCruiseRules(matrix) {
  const { layers, packages } = matrix;
  const packagePaths = Object.keys(packages);
  const rules = [];

  for (const [fromPath, fromLayer] of Object.entries(packages)) {
    const mayDependOn = new Set(layers[fromLayer] ?? []);
    const forbiddenTargets = packagePaths.filter((targetPath) => {
      if (targetPath === fromPath) return false;
      const targetLayer = packages[targetPath];
      return !mayDependOn.has(targetLayer);
    });
    if (forbiddenTargets.length === 0) continue;
    const forbiddenRegex = forbiddenTargets.map(packagePathRegex).join('|');
    rules.push({
      name: `layer-${fromLayer}-cannot-depend-on-forbidden-layers`,
      comment: `${fromPath} (layer ${fromLayer}) must not depend on: ${forbiddenTargets.join(', ')}`,
      severity: 'error',
      from: { path: packagePathRegex(fromPath) },
      to: { path: forbiddenRegex },
    });
  }

  if (matrix.rules.forbidCircular) {
    rules.push({
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    });
  }

  if (matrix.rules.forbidDeepImports) {
    // Cross-package imports must go through the package entry point, never /src/… internals.
    rules.push({
      name: 'no-deep-cross-package-imports',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: String.raw`^(?!packages/[^/]+/src/index\.ts$)packages/[^/]+/src/.+` },
    });
  }

  if (matrix.rules.forbidImportingApps) {
    rules.push({
      name: 'nothing-imports-app-composition',
      severity: 'error',
      from: { path: '^(?!apps/)' },
      to: { path: '^apps/' },
    });
  }

  // Domain-layer packages stay provider-free: npm dependencies are limited to the allowlist.
  const allow = (matrix.domainExternalAllowlist ?? []).map((name) => `^${escapeRegex(name)}$`);
  if (Object.values(packages).includes('domain')) {
    rules.push({
      name: 'domain-packages-provider-free',
      severity: 'error',
      from: {
        path: Object.entries(packages)
          .filter(([, layer]) => layer === 'domain')
          .map(([p]) => packagePathRegex(p))
          .join('|'),
      },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-bundled', 'npm-no-pkg'],
        pathNot: allow.length > 0 ? allow.join('|') : undefined,
      },
    });
  }

  return rules;
}

/** Options object for dependency-cruiser's programmatic `cruise()` API. */
export function buildCruiseOptions(matrix) {
  return {
    // dependency-cruiser's programmatic API expects the rule set under `ruleSet`
    // and validation enabled explicitly via `validate: true`.
    ruleSet: { forbidden: buildCruiseRules(matrix) },
    validate: true,
    doNotFollow: { path: 'node_modules' },
    fileRegEx: String.raw`\.mts$|\.ts$`,
    tsConfig: { fileName: 'tsconfig.base.json' },
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      exportsCache: false,
    },
    exclude: { path: '(^|/)dist(/|$)|\\.d\\.ts$|fixtures/negative' },
    progressType: 'none',
  };
}

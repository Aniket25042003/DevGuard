# ADR-0002: Dependency-boundary enforcement — dependency-cruiser over a declared matrix

- Status: Accepted (2026-08-25)
- Component: C001
- Context: C001 §28 requires selecting a boundary checker and recording the exact dependency matrix.

## Decision

Use **dependency-cruiser** driven programmatically from
`tooling/boundaries/boundary-matrix.json`. The gate lives in
`scripts/check-boundaries.mjs` and is part of `pnpm lint`.

Enforced rules generated from the matrix:

1. Per-package layer legality: importer package may depend only on packages in
   layers listed by its own layer's `mayDependOn` (self-imports excepted).
2. No circular dependencies.
3. No deep cross-package imports (`packages/*/src/**` internals); packages
   expose exactly one entry point via their `exports` map, and TS `paths` map
   only bare names.
4. Nothing imports app-layer composition shells.
5. Domain-layer packages must remain provider-free: npm dependencies limited to
   the allowlist (currently `zod`).
6. Fail closed: every workspace package must be registered in the matrix before
   it can import or be imported; registered-but-absent packages also fail.

The fixture project under `tooling/fixtures/boundary` proves the checker detects
violations (negative test), and the negative-type fixtures prove strict compiler
flags stay active.

## Exact layer matrix (v1)

See `docs/architecture/README.md` for the table. The JSON file is authoritative;
this document records the initial intent.

## Alternatives considered

- ESLint `import/no-restricted-paths`: path-list based, drifts quickly, weak
  cycle detection, no fail-closed package registration concept.
- Custom script walking imports: reinvents module resolution; dependency-cruiser
  handles TS paths, exports maps, and transpilation correctly.

## Consequences

- New packages require a one-line registration plus tsconfig path addition;
  forgetting either fails CI loudly rather than silently widening the graph.
- The matrix file is the single source consumed by lint, tests, and vitest
  alias generation, preventing drift between tooling layers.

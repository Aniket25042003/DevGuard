# ADR-0006: Test suite layout — centralized tests/ with gated e2e project

- Status: Accepted (2026-08-25)
- Components: C001, C096
- Context: C001 requires unit/integration separation and isolated E2E suites; C096 grows harnesses continuously.

## Decision

Keep production packages free of test files. All suites live under:

```text
tests/
  integration/  Vitest `unit` project — use cases with fakes, contract checks,
                architecture/negative-fixture gates (runs in `pnpm test`)
  e2e/          Vitest `e2e` project — provisioned-infrastructure scenarios,
                single-forked pool, run only via `pnpm test:e2e`
```

## Rationale

- Package manifests stay minimal: no per-package devDependency on test runners
  (pnpm's isolated node_modules would otherwise force every package to declare
  Vitest just to typecheck colocated specs).
- Two tsconfig graphs stay simple: packages compile `src/**`; suite projects
  compile their own trees and reference packages via project references.
- The e2e gate cannot run implicitly — matching the master plan's rule that
  full adversarial/E2E work belongs to later milestones (C097).

## Consequences

- Component unit tests are named by component ID inside `tests/integration/src/<area>/…`
  until volume motivates splitting further.
- When C096 introduces deterministic factories/fakes, they live in
  `tests/integration/src/support/` and are exported through that suite's entry.

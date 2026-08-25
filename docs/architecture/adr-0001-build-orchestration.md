# ADR-0001: Build orchestration — pnpm workspaces without Turborepo

- Status: Accepted (2026-08-25)
- Component: C001
- Context: C001 §28 lists "Adopt Turborepo only if task graph/caching benefit exceeds configuration cost."

## Decision

Use pnpm workspaces with TypeScript project references (`tsc -b`) for task
orchestration. Do not adopt Turborepo at MVP.

## Rationale

- The initial package graph (~10 projects) builds in seconds; remote/local
  caching buys little while adding a config surface, hashing semantics, and
  another daemon to reason about.
- Project references already encode inter-package order correctly and enforce
  declaration-based cross-package typing, which strengthens boundary hygiene.
- Fewer moving parts keeps clean-clone reproducibility (a C001 acceptance
  criterion) trivially auditable.

## Consequences

- If CI wall-time becomes a problem after the workflow/jobs trains land,
  adopting Turborepo is additive: wrap existing scripts, keep `tsc -b` as the
  underlying task. Revisit no earlier than M4.
- Root scripts remain the stable developer/CI contract.

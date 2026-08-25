# DevGuard Engineering Architecture

This directory holds the living engineering architecture documentation and
Architecture Decision Records (ADRs) for DevGuard. Product planning documents
live outside version control by policy; these engineering records are tracked.

## System shape

DevGuard is a GitHub-focused autonomous software-engineering governance control
plane built as a pnpm TypeScript monorepo:

```text
apps/
  web/      UI shell (composition only until frontend milestones)
  api/      HTTP transport composition root (routes arrive with C005+)
  worker/   Background job runtime composition root (C057+)
packages/
  contracts/ Canonical provider-neutral domain contracts and event schemas (C004)
  errors/    Provider-neutral typed error taxonomy (C003)
  config/   Startup-validated runtime configuration and feature flags (C002)
tests/
  integration/  In-process suites: use cases with fakes, contract checks, architecture gates
  e2e/          Gated cross-system suites (run explicitly via `pnpm test:e2e`)
infra/        Local infrastructure definitions (C098)
tooling/      Boundary matrix, fixtures, shared tool configuration data
scripts/      Repository automation (boundary gate, cleanup)
```

## Governing invariant

```text
HTTP/SSE route  →  application use case  →  domain service  →  repository/port
                                                      ↘ provider adapter (GitHub/TrueForge)
```

- Apps compose; they contain no business logic.
- Domain packages are provider-free: no SDK types, no SQL, no transport.
- Adapters and persistence implement inward-facing ports.
- Unknown actions fail closed at every boundary.

## Layer vocabulary and dependency direction

Layers (fixed): `app | application | domain | port | adapter | persistence | ui`
plus a tooling-only `test` pseudo-layer used by verification suites.

| Layer            | May depend on                                             |
| ---------------- | --------------------------------------------------------- |
| `app`            | application, domain, port, adapter, persistence, ui       |
| `ui`             | application, domain, port                                 |
| `application`    | domain, port                                              |
| `domain`         | domain (sibling pure packages only, e.g. config → errors) |
| `port`           | domain                                                    |
| `adapter`        | port, domain                                              |
| `persistence`    | port, domain                                              |
| `test` (tooling) | everything (never shipped)                                |

The authoritative machine-readable declaration is
[`tooling/boundaries/boundary-matrix.json`](../../tooling/boundaries/boundary-matrix.json).
`pnpm lint` runs `scripts/check-boundaries.mjs`, which fails closed on any
unregistered workspace package and validates every import edge against the
declared matrix (including circular imports, deep `/src/` imports, and
provider-free rules for domain packages).

## Quality commands

| Command                             | Purpose                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `pnpm typecheck`                    | Strict project-reference type check (`tsc -b`)               |
| `pnpm build`                        | Clean force build of all projects                            |
| `pnpm lint`                         | ESLint + dependency-boundary gate                            |
| `pnpm format:check` / `pnpm format` | Deterministic Prettier formatting                            |
| `pnpm test`                         | Unit + in-process integration suites (Vitest `unit` project) |
| `pnpm test:e2e`                     | Gated end-to-end suites (Vitest `e2e` project)               |

## Conventions

- **Adding a package:** create the directory under `packages/` (or nested), add
  an ESM `package.json` scoped `@devguard/*` exporting exactly one public entry
  point `.`, extend `tsconfig.base.json#compilerOptions.paths` with its bare
  name, and register it in the boundary matrix. Unregistered packages fail CI.
- **Tests:** colocate nothing in packages today; suites live under `tests/*`.
  Unit/integration run on every change; e2e is explicit and gated.
- **Commits:** Conventional Commits with component IDs, e.g.
  `feat(policy): persist fail-closed action decisions [C030]`.

## ADR index

| ADR                                                       | Decision                                        |
| --------------------------------------------------------- | ----------------------------------------------- |
| [ADR-0001](./adr-0001-build-orchestration.md)             | pnpm workspaces without Turborepo for MVP       |
| [ADR-0002](./adr-0002-dependency-boundary-enforcement.md) | dependency-cruiser with a declared layer matrix |
| [ADR-0003](./adr-0003-api-framework-selection.md)         | HTTP framework selection deferred to C005       |
| [ADR-0004](./adr-0004-runtime-validation-zod.md)          | Zod for runtime validation of external inputs   |
| [ADR-0005](./adr-0005-static-feature-flags-mvp.md)        | Static-only feature flags for MVP               |
| [ADR-0006](./adr-0006-test-suite-layout.md)               | Centralized tests/{unit,integration,e2e} layout |

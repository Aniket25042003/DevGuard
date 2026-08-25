# ADR-0009: HTTP framework — Hono

- Status: Accepted (2026-08-25)
- Component: C005
- Context: C001 §28 deferred the Hono-vs-Fastify decision to C005, binding whichever choice to raw-body webhook intake, reconnectable SSE with cursors, request-ID correlation, the stable error envelope from `@devguard/errors`, and thin controllers.

## Decision

Adopt **Hono** (with its Node runtime adapter) as the `/api/v1` framework.

## Evaluation against binding constraints

| Constraint                 | Hono                                                                               | Fastify                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Raw-body webhook intake    | Trivial: `c.req.raw.arrayBuffer()` gives unmodified bytes before any parsing       | Supported but routed through its own body-parser pipeline |
| SSE with cursors/heartbeat | First-class streaming helpers; plain `ReadableStream`                              | Plugin-based                                              |
| Schema validation          | Zod-native patterns; schemas stay the single source (C004/ADR-0004)                | JSON-Schema-centric; would duplicate Zod definitions      |
| TypeScript ergonomics      | TS-first typed handlers matching strict monorepo                                   | Mature but heavier generics                               |
| Composition fit            | Middleware chain is explicit and ordered — matches the fixed TransportKernel order | Plugin model adds abstraction between order guarantees    |

## Consequences

- `apps/api` gains the only HTTP dependency in the workspace; all other packages stay transport-free.
- Tests drive the app directly via Hono's in-process `app.request()` — no listening sockets needed, keeping CI hermetic.
- If Hono must be replaced, the TransportKernel contracts (`packages/api-contracts`) plus route metadata registry localize the blast radius.

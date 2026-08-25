# ADR-0003: HTTP framework selection deferred to C005

- Status: Open → delegated (2026-08-25)
- Component: C001 (foundation stays neutral), decided finally in C005
- Context: C001 §28 leaves "Hono versus Fastify" as an open decision owned by C005.

## Decision

The foundation introduces **no HTTP framework**. `apps/api` remains a
composition shell; `@devguard/errors` provides transport-neutral public error
projections so either choice maps onto the same envelope.

Candidates to evaluate in C005:

| Option  | Strengths for DevGuard                                                                                             | Watch-outs                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Hono    | First-class Web-standard handlers, SSE support, tiny core, easy raw-body access for webhook signature verification | Smaller ecosystem for auth middleware patterns             |
| Fastify | Mature plugin/auth ecosystem, schema-based serialization, SSE plugins                                              | Heavier abstraction; JSON schema duplication alongside Zod |

Constraints binding whichever is chosen: raw-body webhook intake (C022/C075),
reconnectable SSE with cursor replay (C068), request-ID correlation, stable
error envelope mapping from `@devguard/errors`, and no business logic in routes.

## Consequences

None yet beyond keeping foundation packages transport-free; recorded here so
the eventual decision is visible next to its prerequisite context.

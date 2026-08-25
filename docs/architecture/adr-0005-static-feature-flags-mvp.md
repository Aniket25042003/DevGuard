# ADR-0005: Static-only feature flags for MVP

- Status: Accepted (2026-08-25)
- Component: C002
- Context: C002 §28 offers "static-only flags for MVP unless operational need justifies persisted overrides."

## Decision

Ship feature flags as a **static registry**: code defaults overridden only by
environment variables, evaluated into immutable decisions at startup. The
persisted-override repository (`FeatureFlagOverrideRepository` port in C002)
is defined but has no implementation until an operational need appears.

## Rationale

- Flags must only ever _narrow_ capability; dynamic enablement adds an
  authorization-adjacent mutation path with no MVP consumer.
- Restart-reproducible configuration simplifies the "restart recreates
  equivalent config" acceptance criterion.
- Hard safety constraints always win regardless of flag source; fewer flag
  sources means fewer audit paths to defend.

## Consequences

- Enabling a risky capability (e.g., provider writes) requires a deploy-time
  environment change plus the documented safety gates (W0–W6) — intentional
  friction.
- If persisted overrides become necessary, the port already fixes CAS row
  versions, expiry, actor, and reason semantics; implementation lands behind
  the existing interface without changing evaluation precedence.

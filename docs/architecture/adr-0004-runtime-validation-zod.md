# ADR-0004: Zod for runtime validation of external inputs

- Status: Accepted (2026-08-25)
- Components: C002, C003, C004 (consumers)
- Context: PRD ARCH-04 requires runtime-validating external input; contracts need typed schemas that double as validators at boundaries.

## Decision

Adopt **Zod** as the single runtime-validation library for environment parsing,
contract/event schema validation, and safe-detail validation in the error
taxonomy. Domain-layer packages may depend on Zod (it is the sole entry on the
boundary matrix's domain external allowlist).

## Rationale

- One schema definition yields both static types and runtime checks, matching
  the "discriminated unions/stable enums + validated boundaries" requirement.
- Errors package needs per-code safe-detail schemas; sharing Zod with C004
  event envelopes keeps one validation idiom across trust boundaries.
- Small, tree-shakeable, zero transitive deps — compatible with the
  provider-free domain constraint.

## Consequences

- Provider SDK types never replace contract schemas; adapters normalize into
  Zod-validated internal shapes.
- Version upgrades treat schema output as a compatibility surface (C004 owns
  the evolution policy).

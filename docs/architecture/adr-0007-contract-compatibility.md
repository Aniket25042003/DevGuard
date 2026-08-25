# ADR-0007: Contract compatibility policy and identifier strategy

- Status: Accepted (2026-08-25)
- Component: C004 (IF-1 domain vocabulary freeze)
- Context: C004 §28 asks for a compatibility window, an event upcasting policy, and an ID strategy.

## Decision

### Schema versioning

- Every event envelope carries `schemaVersion`, currently frozen at `1`.
- **Within v1, changes must be additive**: new optional payload keys, new
  registered event types, new enum members on producer-only fields. Unknown
  keys in payloads are stripped on read; unknown event types and versions fail
  closed (quarantine), never parse best-effort.
- **Breaking changes** (removing/renaming fields, narrowing types, changing
  status vocabularies) require `schemaVersion: 2` and a dual-write/migration
  window owned by the emitting component.
- Golden fixtures (`tests/integration/src/contracts/fixtures/golden-events.json`)
  must keep parsing after any change; CI blocks the merge when they do not.

### Strictness split

| Surface                               | Policy                            | Rationale                                              |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Event envelopes & internal payloads   | strip unknown keys                | forward-compatible producers/consumers within v1       |
| Public/browser DTOs (`src/public.ts`) | `.strict()` — reject unknown keys | over-posting is an attack surface at trust boundaries  |
| External provider refs                | `.strict()`                       | provider drift must be explicit, not silently absorbed |

### Identifiers

- Canonical IDs are lowercase UUID-shaped opaque strings. Generators SHOULD
  produce UUIDv7 for sortability; ULID is tolerated by validation for
  interoperability. Ordering authority always lives with explicit `sequence`
  fields — never with ID sort order or timestamps.

### Status vocabularies

Workflow/approval/step/validation statuses are lowercase enums frozen here
(IF-1). Approval resolution is approval state; workflow statuses include
`waiting_for_approval`/`resuming` rather than borrowing approval states.
Authorization effects remain exactly `ALLOW | REQUIRE_APPROVAL | DENY`; sandbox
placement is modeled as an obligation attached to decisions.

## Consequences

- Consumers can be deployed before producers finish rolling out additive
  changes; the reverse also holds because unknown types quarantine loudly.
- Any vocabulary change shows up as a reviewed contract diff touching
  `packages/contracts/src/**` plus fixtures in the same PR.

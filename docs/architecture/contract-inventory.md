# Contract Inventory (C004)

Authoritative map of `packages/contracts`. Only cross-boundary types belong
here; behavior lives in owning components. Changes to this package are
contract changes and follow ADR-0007.

| Module            | Contents                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.ts`   | Branded IDs (user, installation, repository, policy, workflow, session, turn, action, approval, artifact, validation, finding, event, delivery, audit, operation key), ISO timestamps, sequences, row versions, exhaustive-match helper, bounded text |
| `context.ts`      | Actor kinds/refs (user, github_app, agent, system, webhook_actor), correlation ids, provenance + GitHub external refs, data classification                                                                                                            |
| `repositories.ts` | Connected repository projection + lifecycle status (`pending                                                                                                                                                                                          | active | degraded | disconnected`), user principal |
| `policy.ts`       | Action taxonomy (19 canonical action types), risk classes, autonomy levels, three authorization effects, obligations (execution environment/network/timeout/resources/secrets), decision shape, tool→action binding                                   |
| `workflows.ts`    | Workflow statuses (10, IF-1), terminal set, step statuses, MVP workflow kinds, triggers, run shape with cancellation generation, structured completion evidence, agent session refs                                                                   |
| `approvals.ts`    | Approval statuses (8), terminal set, exact-target fingerprint inputs, request shape with checkpoint correlation (pause/resume only)                                                                                                                   |
| `evidence.ts`     | Artifacts (checksum/classification/storage ref), validation results bound to commit SHAs, security findings with provenance and explicit `unknown` severity                                                                                           |
| `events.ts`       | Versioned envelope (v1) and registry of 24+ foundation event types across configuration, authorization, repository, workflow, action, policy, approval, artifact, validation, webhook, outbox families                                                |
| `public.ts`       | Browser-safe strict DTOs (workflow run summary, approval view)                                                                                                                                                                                        |

## Boundary rules

1. No behavior, no I/O, no SQL, no provider SDK types — schemas only.
2. Domain packages may refine around these values but never duplicate enums.
3. Persistence/API/adapters map to/from contracts; raw rows and SDK models
   stop at their boundary.
4. Frontend consumes only `public.ts` projections and parsed events.

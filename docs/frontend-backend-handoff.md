# Frontend → Backend Handoff

This document is the implementation ledger for backend work required by the redesigned DevGuard web control plane. The frontend may render every state and interaction now, but it must not claim an unavailable capability is complete. Each item below describes the server contract the UI expects.

## 1. Workspace command center

**Frontend surface:** `/repositories` (workspace overview), repository overview, global approvals.

**Required backend work:**

- Add a durable workspace activity projection that returns the latest runs, pending approvals, provider readiness, policy posture, and last meaningful event across repositories visible to the principal.
- Scope every row through `repository:read`; approval actions require a fresh `approval:resolve` check.
- Return explicit states (`queued`, `dispatch_pending`, `running`, `waiting_for_approval`, `verifying`, `completed`, `failed`, `blocked`, `unavailable`, `cancelled`) rather than omitting rows when a provider is unavailable.
- Include `repositoryId`, repository display name, workflow type, target reference, trigger origin, status, `updatedAt`, `requestId`, and a stable `workflowRunId` for deep linking.

**Suggested endpoint:** `GET /api/v1/activity?scope=workspace&limit=<n>&cursor=<cursor>`.

The typed server seam for this projection is now defined in
`apps/api/src/composition/frontend-projection-contracts.ts`. It intentionally
has no volatile implementation; wiring should wait for a durable read model.

## 2. Live run projection

**Frontend surface:** repository run list and `/repositories/:repositoryId/workflows/:runId`.

**Required backend work:**

- Complete the outbox dispatcher and worker execution path so a persisted command can become a durable worker job.
- Compose the TrueForge agent session, sandbox workspace, MCP policy gateway, workflow step executor, cancellation fence, and evidence writer in the worker.
- Persist an append-only run event stream with monotonically increasing sequence numbers and a resumable cursor.
- Emit normalized events for intent, policy decision, sandbox creation, agent turn, tool proposal, approval creation/resolution, validation, artifact publication, finding publication, provider outage, and terminal outcome.
- Expose `GET /api/v1/sessions/:sessionId/events` plus SSE with `Last-Event-ID`; the stream must reconcile missed events and close with an explicit terminal status.
- Return a projection version or event sequence on run detail so React Query can safely reconcile summary data with the stream.

**Suggested response additions:** `phase`, `phaseLabel`, `sandbox`, `policySnapshot`, `riskSummary`, `evidenceSummary`, `updatedAt`, `terminalReason`, `projectionVersion`.

## 3. Governed action execution

**Frontend surface:** run evidence panel, blocked/unavailable states, verification summary.

**Required backend work:**

- Evaluate every proposed action against the immutable policy snapshot attached to the run.
- Persist an action record before execution containing `actionId`, normalized action type, target fingerprint, risk class, policy decision, actor/session binding, and current state.
- Route `allow`, `require_approval`, `deny`, and `unknown` to distinct durable outcomes. Unknown must fail closed.
- Bind all sandbox commands and GitHub mutations to the run, workspace, and policy version that authorized them.
- Record before/after verification evidence and make it retrievable without exposing unsafe artifact bytes.

## 4. Approval center and resume

**Frontend surface:** `/approvals`, run approval panel, approve/reject confirmation.

**Required backend work:**

- Enforce `approval:resolve` plus a fresh repository permission check before every resolution.
- Return the exact operation, repository/branch/PR target, risk class, rationale, expiry, policy version, target fingerprint, and expected next effect.
- Make approval resolution idempotent and version-checked; stale, expired, already-resolved, and unknown approvals must have distinct safe error codes.
- Persist a resume intent/outbox event after a successful resolution. The worker must revalidate current policy and target state before executing exactly once.
- Publish resolution and resume events to the run stream and workspace activity projection.

## 5. Policy editor

**Frontend surface:** repository policy editor and history.

**Required backend work:**

- Validate the complete draft and return canonical JSON/YAML, `draftDigest`, issues, danger-increasing changes, and the policy version used for validation.
- Reject saves where the submitted digest no longer matches the submitted draft or active policy ETag.
- Persist immutable policy versions with canonical content, hash, author, timestamp, and change summary.
- Add a rollback command that creates a new version after the same validation and authorization path; never mutate historical rows.
- Return machine-readable action effect and autonomy metadata so the frontend does not infer policy meaning from labels.

## 6. Artifacts and findings

**Frontend surface:** run artifacts, security findings, remediation launcher.

**Required backend work:**

- Resolve the conflicting artifact migrations and make the repository schema match `PostgresArtifactStore`.
- Store immutable artifact bytes in shared durable object storage, not per-process local `/tmp` folders.
- Enforce `artifact:read` and repository visibility before metadata or bytes are returned.
- Return scan state (`pending`, `safe`, `quarantined`, `unavailable`), checksum, size, retention, and a short-lived access URL only for safe artifacts.
- Scope findings to an authorized repository/run and include severity, status, file/line evidence, scanner provenance, and remediation availability.

## 7. Readiness and integrations

**Frontend surface:** shell status, preflight page, GitHub settings, unavailable gates.

**Required backend work:**

- Provide a single readiness projection for database, Redis, GitHub App, TrueForge, sandbox execution, object storage, and worker consumption.
- Distinguish `healthy`, `degraded`, `unavailable`, `disabled`, and `unknown`; include safe remediation copy and a request ID.
- Gate launch, approval resume, and GitHub write capabilities with feature flags and readiness, server-side as well as in UI.
- Replace process-local production rate limiting with a shared limiter.

## 8. Authentication and authorization closure

Before enabling privileged UI actions in production, close the route gaps identified in the architecture audit:

- Authorize artifact and finding reads against the run's repository.
- Enforce capability and fresh GitHub permission checks on nested and global approval routes.
- Preserve non-enumeration: missing and forbidden resources must return the same public result.
- Keep API error envelopes stable: `{ error: { code, message, requestId, retryable, details? } }`.

## Implementation order

1. Fix migrations and authorization boundaries.
2. Dispatch outbox intents and implement durable worker execution/read-only sandbox evidence.
3. Add normalized run events and projection reconciliation.
4. Implement approval resume with revalidation.
5. Enable guarded GitHub writes and artifact delivery only after verification evidence is durable.

## Verification snapshot

- Web typecheck: passing.
- Web tests: 14 passing.
- Web production build (`next build --webpack`): passing. The default Turbopack
  build is currently blocked by the local sandbox denying its CSS worker port.
- API TypeScript build: passing.
- Focused backend recovery suites pass across command/workflow, webhook,
  approval, queue, TrueForge, and sandbox paths; all seven baseline failures
  are fixed. Full service-backed integration remains a CI gate.

## Backend audit register (2026-09-03)

The following findings are the implementation ledger for the backend recovery
work. P0 items block a production release; P1 items must be closed before
enabling unattended runs.

| ID     | Priority | Finding                                                                                                                                                                                | Required closure                                                                                                             |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| BE-001 | P0       | Routes construct `ConnectedRepositoryStore` directly. The assembled CP006 tests therefore open a real pool against the fake `postgres://x` URL and six command-route tests return 500. | Make routes transport-only and inject repository lookup/policy ports; bind deterministic test adapters.                      |
| BE-002 | P0       | The workflow registry/orchestrator/executor are not composed, and four of five MVP definitions are not registry-complete.                                                              | Register all five MVP workflows and use one durable orchestrator.                                                            |
| BE-003 | P0       | In-memory and database workflow states differ; semver versions are truncated to an integer; `expired` is legal in code but rejected by SQL.                                            | Establish one lowercase persisted state model and store semver text end-to-end.                                              |
| BE-004 | P0       | Redis claim/retry/heartbeat/fencing is non-atomic, and `outbox.publish` is a bootstrap cycle.                                                                                          | Use a PostgreSQL outbox relay plus BullMQ stable job IDs, retries, leases, and dead letters.                                 |
| BE-005 | P0       | Agent sessions and turns are in-memory; submit/observe/reconcile do not call TrueForge.                                                                                                | Add durable session/turn stores and an official TrueForge SDK adapter.                                                       |
| BE-006 | P0       | No production sandbox workspace store/provider is composed; the command adapter has mutable shared command state and incomplete result accounting.                                     | Persist workspace leases/generations, bind a verified provider, and make commands concurrency-safe.                          |
| BE-007 | P0       | Policy action identifiers use incompatible dotted and underscore vocabularies; run-level decisions overwrite one another.                                                              | Make dotted action IDs canonical and persist append-only decisions per action.                                               |
| BE-008 | P0       | Approval persistence omits exact operation/action/checkpoint bindings and resolution does not enqueue durable resume work.                                                             | Bind approvals to an action fingerprint, require CAS/idempotency/fresh auth, and emit resume outbox work.                    |
| BE-009 | P0       | Migration 011 conflicts with the richer artifacts table created in migration 005; `PostgresArtifactStore` queries columns that do not exist.                                           | Keep migration history immutable, adopt the migration-005 schema, and add a forward reconciliation migration.                |
| BE-010 | P0       | API and worker use separate local `/tmp` artifact stores; scan state is effectively trusted.                                                                                           | Use shared S3-compatible storage, staged upload/finalize/scan/quarantine, and authorized signed URLs.                        |
| BE-011 | P0       | Webhook delivery is committed before outbox work, raw payloads cannot be replayed, missing delivery IDs collide, and comment identity can violate the users FK.                        | Persist verified payload references and delivery/outbox intent atomically; consolidate ingress and repair identity creation. |
| BE-012 | P0       | Only acknowledgement comments are composed; branch/commit/PR/review/merge writes are not durable or reconciled.                                                                        | Add installation-token-scoped mutation receipts, head-SHA checks, and provider reconciliation.                               |
| BE-013 | P0       | Repository listing is scoped to `connected_by`, so installation teammates cannot see shared repositories.                                                                              | Scope visibility through active `user_installation_links`; retain `connected_by` only as audit metadata.                     |
| BE-014 | P1       | Nested artifact/finding/approval/policy/run routes have inconsistent capability checks and enumeration behavior.                                                                       | Centralize resource loading and use stable 404/403 rules plus one error envelope.                                            |
| BE-015 | P1       | Run events/projections are incomplete and workflow/diagnostic cursors use incompatible formats.                                                                                        | Add append-only sequenced events and one versioned opaque cursor codec.                                                      |
| BE-016 | P1       | Cancellation, command deadlines, stream backpressure, worker draining, and stale-run recovery are incomplete.                                                                          | Propagate abort signals, add leases/heartbeats/reconciliation, and record real duration/results.                             |
| BE-017 | P1       | Readiness checks only process/database health; production flags enable unimplemented TrueForge/sandbox/approval paths.                                                                 | Probe every dependency and gate features server-side on readiness.                                                           |
| BE-018 | P1       | Secret values can enter runtime hashes/diagnostics; local artifact storage is accepted in production; Redis is not used for API limiting.                                              | Redact sensitive config, reject unsafe production storage, and use a shared Redis limiter.                                   |
| BE-019 | P1       | Render and API startup each attempt migrations.                                                                                                                                        | Run migrations only in the deploy step; startup performs read-only schema verification.                                      |
| BE-020 | P1       | Database suites silently skip without a test database and async/Redis warnings remain.                                                                                                 | Provision PostgreSQL/Redis in CI and make skipped service tests explicit failures.                                           |

### Exact red-test baseline

- CP006 `command-routes.test.ts`: listing, initial submit, replay, idempotency-conflict setup, unknown-command, and extension-command tests return 500 because the route bypasses injected bindings and opens a real pool.
- C067 workflow start returns 400 for an empty review input. This is correct schema enforcement because a review requires `pullRequestNumber`; the fixture must be corrected rather than weakening validation.
- Baseline at audit time: 1,084 passing, 7 failing, 28 skipped.

### Canonical backend decisions

- GitHub App installation/account is the tenancy boundary; `user_installation_links` supplies membership and GitHub supplies privileged role evidence.
- PostgreSQL remains authoritative. BullMQ is the delivery/concurrency layer behind a transactional outbox.
- Workflow commands remain underscore IDs; policy actions use dotted IDs.
- Workflow lifecycle status and provider availability are separate fields.
- Migration 005's artifact schema is canonical; migration files are immutable.
- TrueForge is the only agent/sandbox runtime; there is no host fallback.

### Recovery implementation update (2026-09-03)

- API and worker now use explicit composition bindings; test composition never
  opens a network database pool accidentally.
- Workflow versions are semver strings and lifecycle transitions include
  `dispatch_pending`, `provisioning`, and `expired`.
- Worker delivery uses a PostgreSQL outbox relay and BullMQ with stable
  `outbox:<eventId>` IDs, preserved attempts, dead-letter handling, and drain.
- Webhook delivery insertion and outbox intent are transactional; event and
  delivery headers are mandatory and payload references are content-digests.
- Repository visibility follows active installation membership. Approval
  resolution requires `Idempotency-Key` and `If-Match` and emits a durable
  `approval.resume_requested` intent when approved.
- A pinned official TrueForge SDK adapter is available; sandbox commands no
  longer rely on a process-wide mutable command ID.
- S3-compatible artifact storage is implemented, migration-005 artifact SQL
  is canonical, scan state defaults to pending, and retention marks `EXPIRED`.
- Workflow and diagnostics lists share one strict versioned base64url cursor.
  Render/API/worker migration execution is reduced to pre-deploy plus
  read-only startup schema checks.
- Agent sessions/turns now persist command keys, provider references, lifecycle
  state, and cancellation generations in Postgres; submit and observe call the
  provider-neutral TrueForge adapter and reconcile provider status.
- Approval resume state is durable in `approval_resume_states`; worker resume
  jobs atomically requeue the owning workflow with a stable idempotency key
  instead of using an in-memory store or an always-failing executor.
- Workflow execution claims an atomic Postgres lease with owner, token,
  expiration, and generation fencing; duplicate deliveries converge safely.
- API readiness now probes live Redis, TrueForge capabilities, database health,
  and production S3 configuration. Worker startup performs live dependency
  probes and only advertises `/ready` when dependencies are healthy.
- Verification after this slice: `pnpm typecheck`, API/worker/agent/db builds,
  and the full unit project pass (1,078 tests); 28 service-backed tests remain
  skipped when `DEVGUARD_TEST_DATABASE_URL` is not supplied. Webpack production
  build passes; Turbopack remains environment-blocked by the sandbox port
  restriction documented above.

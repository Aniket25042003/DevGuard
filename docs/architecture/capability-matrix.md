# Repository Capability Matrix (C006)

Every repository-scoped operation declares exactly ONE capability from
`@devguard/authorization`. Transport order on every route:

```text
authenticate (C005 principal) → authorize capability (C006) → load/execute use case
```

## Capability → minimum GitHub role floor

| Capability                     | Minimum normalized role | Fresh check mandatory |
| ------------------------------ | ----------------------- | --------------------- |
| `repository:read`              | read                    | no (TTL evidence)     |
| `artifact:read`                | triage                  | no (TTL evidence)     |
| `policy:read`                  | triage                  | no (TTL evidence)     |
| `workflow:start`               | write                   | no (TTL evidence)     |
| `workflow:cancel`              | write                   | YES                   |
| `policy:write`                 | maintain                | YES                   |
| `approval:resolve`             | maintain                | YES                   |
| `repository:privileged_action` | maintain                | YES                   |
| `repository:connect`           | admin                   | YES (connect-time)    |

Fresh-mandatory capabilities NEVER serve allow decisions from cached evidence
(`requiresFreshCheck`). GitHub permission-provider outages fail closed
(503 `DEPENDENCY_UNAVAILABLE`) rather than allowing.

## Route mapping

### Implemented (this PR)

| Route                       | Auth class              | Capability    |
| --------------------------- | ----------------------- | ------------- |
| `GET /api/v1/auth/session`  | optional_session        | — (self only) |
| `GET /api/v1/auth/login`    | public (rate-limited)   | —             |
| `GET /api/v1/auth/callback` | public (rate-limited)   | —             |
| `POST /api/v1/auth/logout`  | required_session + CSRF | — (self only) |

### Reserved mappings (owned by later components; enforced when those routes land)

| Route group                                              | Owner | Capability(s)                                                                                    |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `/api/v1/repositories*`                                  | C065  | `repository:read`, `repository:connect`, `workflow:read` via `repository:read` for run summaries |
| `/repositories/:id/policy*`                              | C066  | `policy:read`, `policy:write`                                                                    |
| `/repositories/:id/workflows`, `/workflows/:id(/cancel)` | C067  | `workflow:start`, `repository:read`, `workflow:cancel`                                           |
| `/sessions/:id…`                                         | C068  | `repository:read` (session visibility follows run visibility)                                    |
| `/repositories/:id/commands`                             | C069  | mapped per command (`workflow:start` or action-specific)                                         |
| `/approvals*`                                            | C070  | `approval:resolve`; listing uses `repository:read`                                               |
| `/workflows/:id/artifacts`, `/artifacts/:id`             | C071  | `artifact:read`                                                                                  |
| `/audit*`, `/actions/:id`                                | C072  | `repository:read` (audit visibility scoped per repository)                                       |
| `/security-findings*`                                    | C073  | `repository:read`; remediation start = `workflow:start`                                          |
| `/health/*`, `/diagnostics/preflight`                    | C074  | operator/admin gate outside repository scope                                                     |
| `POST /webhooks/github`                                  | C075  | signature-verified; CSRF-exempt                                                                  |

## System actors

Worker services act as `kind:'system'` principals with a service id plus a
binding to the persisted `workflowRunId`/`approvalId` they execute. They can
hold ONLY `workflow:start`, `workflow:cancel`, `approval:resolve`; binding
mismatches deny. Forging user principals is structurally impossible (the union
is discriminated by `kind`).

## Non-enumeration policy

Authorization failures before resource loading throw the constant
`REPOSITORY_FORBIDDEN` error regardless of whether the repository exists,
yielding identical public output for "missing" and "forbidden". Routes MAY map
denials to deliberate 404s per their plan; they must never return repository
metadata.

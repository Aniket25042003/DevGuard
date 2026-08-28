# DevGuard

**Autonomous software engineering with a license to act.**

DevGuard is a GitHub-focused autonomous software-engineering control plane. It
gives an AI software engineer the ability to inspect repositories, understand
issues, modify code, run generated code in an isolated sandbox, validate
changes, open pull requests, react to review feedback, and execute repository
actions only within an explicit autonomy policy.

## What it does

1. **Junior Dev in a Box** — turn GitHub issues into inspected, tested pull
   requests (`implement_issue`).
2. **Security Patch Agent** — remediate findings in isolation and prove them
   fixed with a comparable re-scan (`security_patch`, `security_audit`).
3. **Repo Surgeon** — diagnose failing tests, regressions, and other defects,
   then produce and validate a repair (`diagnose_failure`).

Maintainers choose how much authority DevGuard has per repository: which
workflows can start manually or from GitHub events, which actions are allowed,
which require human approval, which are forbidden, and which validations must
pass before a pull request can be opened or updated.

## Architecture at a glance

| Layer         | Responsibility                                                                        |
| ------------- | ------------------------------------------------------------------------------------- |
| **DevGuard**  | Product governance, deterministic policy, durable approvals, workflows, audit, and UX |
| **TrueForge** | Agent runtime — sessions, MCP tools, sandbox execution, streaming, checkpoints        |
| **GitHub**    | System of record for source, issues, pull requests, checks, and reviews               |
| **Humans**    | Authorize exact privileged actions                                                    |

**Core rule:** the model proposes; DevGuard governs and records; TrueForge runs;
GitHub holds repository truth; a human authorizes exact high-impact actions.

## Repository layout

- `packages/*` — domain modules and adapters (foundation, persistence, GitHub,
  policy, approvals, agent, sandbox, workflows, queue, observability, security,
  API contracts, test harness). Each is an immutable, versioned component.
- `apps/api` — versioned REST/SSE/webhook transport (`kernel.registerV1Route`).
- `apps/worker` — queue consumers, workflow orchestration, provider calls.
- `apps/web` — Next.js UI.
- `tests/integration` — per-component integration + security (`ci / unit`).
- `tests/e2e` — gated end-to-end project (`pnpm test:e2e`).
- `docs/implementation-plan` — the 100-component plan (source of truth).

## Tech stack

- **Language:** TypeScript (strict; `exactOptionalPropertyTypes`)
- **Monorepo:** pnpm workspaces
- **Frontend:** Next.js, React
- **Backend:** TypeScript API/services
- **Database:** PostgreSQL (authoritative), object storage for large artifacts
- **Jobs:** Redis + worker queue
- **Sandbox:** TrueForge-managed (generated code never runs on the DevGuard host)
- **Integrations:** GitHub App, TrueForge

## Safety model

- Repository policy and autonomy levels control what the agent may do.
- Unknown or ambiguous actions **fail closed**.
- High-risk operations require durable human approval bound to the exact proposed
  action and target-state fingerprint.
- Generated code executes only in a TrueForge sandbox.
- Repository instructions are untrusted and cannot override DevGuard policy.
- Every privileged path is auditable: classify → evaluate policy → persist
  decision → approve if required → revalidate → execute → verify.

## Documentation

- [Architecture](docs/architecture/README.md)
- [Deployment topology](docs/deployment/deployment-topology.md)
- [Demo guide](docs/deployment/demo-guide.md)
- [Troubleshooting](docs/deployment/troubleshooting.md)
- [Local development](docs/local-development.md)

## Status

The backend control plane is implemented across 100 planned components
(`docs/implementation-plan/01-component-inventory.md`); the deterministic
portions of the E2E/adversarial matrix (C097) and the deployment topology/demo
framework (C100) are in the repository. The frontend app is scaffolded and the
live-provider demo requires provisioned GitHub App + TrueForge credentials
(see the demo guide for honest `LIVE` vs `HISTORICAL` vs `REHEARSAL` labeling).

## License

Proprietary / TBD.

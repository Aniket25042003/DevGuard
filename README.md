# DevGuard

**Autonomous software engineering with a license to act.**

DevGuard is a GitHub-focused autonomous software-engineering control plane. It gives an AI software engineer the ability to inspect repositories, understand issues, modify code, run generated code in an isolated sandbox, validate changes, open pull requests, react to review feedback, and execute repository actions only within an explicit autonomy policy.

## What it does

1. **Junior Dev in a Box** — turn GitHub issues into inspected, tested pull requests.
2. **Security Patch Agent** — find security weaknesses and remediate issues that are safely fixable.
3. **Repo Surgeon** — diagnose failing tests, regressions, bugs, and other repository defects, then produce and validate a repair.

Maintainers choose how much authority DevGuard has per repository: which workflows can start manually or from GitHub events, which actions are allowed, which require human approval, which are forbidden, and which validations must pass before a pull request can be opened or updated.

## Architecture at a glance

| Layer | Responsibility |
| --- | --- |
| **DevGuard** | Product governance, deterministic policy, durable approvals, workflows, audit, and UX |
| **TrueForge** | Agent runtime — sessions, MCP tools, sandbox execution, streaming, checkpoints |
| **GitHub** | System of record for source, issues, pull requests, checks, and reviews |
| **Humans** | Authorize exact privileged actions |

**Core rule:** the model proposes; DevGuard governs and records; TrueForge runs; GitHub holds repository truth; a human authorizes exact high-impact actions.

## Tech stack

- **Language:** TypeScript
- **Frontend:** Next.js, React, Tailwind CSS
- **Backend:** TypeScript API / services
- **Database:** PostgreSQL
- **Jobs:** Redis + worker queue (e.g. BullMQ)
- **Sandbox:** TrueForge-managed (generated code never runs on the DevGuard host)
- **Integrations:** GitHub App, TrueForge

## Safety model

- Repository policy and autonomy levels control what the agent may do.
- Unknown or ambiguous actions fail closed.
- High-risk operations require durable human approval bound to the exact proposed action.
- Generated code executes only in a TrueForge sandbox.
- Repository instructions are untrusted and cannot override DevGuard policy.
- Every privileged path is auditable: classify → evaluate policy → persist decision → approve if required → revalidate → execute → verify.

## Status

Greenfield project. Application source, migrations, and deployable services are not yet implemented in this repository.

## License

Proprietary / TBD.

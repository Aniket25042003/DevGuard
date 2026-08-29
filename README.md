# DevGuard

**Autonomous software engineering with a license to act.**

DevGuard is a GitHub-focused control plane for autonomous software engineering. It lets AI agents inspect repositories, understand issues, modify code, run changes in an isolated sandbox, validate results, open pull requests, and respond to review feedback — all within explicit, enforceable autonomy policies that maintainers define per repository.

**Live demo:** [devguard-olive.vercel.app](https://devguard-olive.vercel.app) · **Demo video:** [marketing/demo-video](marketing/demo-video/)

---

## Overview

DevGuard gives engineering teams a single place to **launch**, **govern**, and **audit** agent work across three surfaces:

| Surface | What you can do |
| --- | --- |
| **Web** | Connect repositories, configure policy, launch workflows, and review approvals |
| **CLI** | Run governed commands from the terminal — start reviews, watch runs, approve gated actions |
| **GitHub** | Trigger workflows from pull request comments and receive inline policy and status updates |

Every run — regardless of where it started — flows through the same policy engine, approval gates, sandboxed execution, and audit trail.

---

## The problem

Teams want AI agents that can ship real code, not just suggest it. But unconstrained automation creates risk: unreviewed changes, policy bypasses, unsafe execution on production hosts, and no durable audit trail when something goes wrong.

Most agent tooling treats governance as an afterthought. DevGuard treats it as the product.

---

## What DevGuard does

DevGuard sits between your team, GitHub, and an agent runtime. It classifies every proposed action, evaluates repository policy, records decisions, requires human approval when configured, and only then delegates execution to the runtime.

**Built-in workflows:**

| Workflow | Purpose |
| --- | --- |
| **Junior Dev in a Box** (`implement_issue`) | Turn GitHub issues into inspected, tested pull requests |
| **Security Patch Agent** (`security_patch`, `security_audit`) | Remediate findings in isolation and prove fixes with a comparable re-scan |
| **Repo Surgeon** (`diagnose_failure`) | Diagnose failing tests and regressions, then produce and validate a repair |

Maintainers control how much authority DevGuard has: which workflows can start manually or from GitHub events, which actions are allowed or forbidden, which require approval, and which validations must pass before a pull request is opened or updated.

---

## Architecture

DevGuard separates **governance** from **execution** and keeps GitHub as the system of record.

| Layer | Role |
| --- | --- |
| **DevGuard** | Policy, approvals, workflows, audit, and operator UX |
| **TrueForge** | Agent runtime — sessions, MCP tools, sandbox execution, streaming |
| **GitHub** | Source of truth for code, issues, pull requests, checks, and reviews |
| **Humans** | Authorize high-impact actions when policy requires it |

**Core rule:** the model proposes; DevGuard governs and records; TrueForge runs; GitHub holds repository truth; humans authorize exact privileged actions when required.

```text
HTTP/SSE route  →  application use case  →  domain service  →  repository/port
                                                      ↘ provider adapter (GitHub / TrueForge)
```

Apps compose services; domain packages stay provider-free. Adapters implement inward-facing ports. Unknown or ambiguous actions fail closed at every boundary.

---

## Tech stack

DevGuard is a **pnpm TypeScript monorepo** with strict typing (`exactOptionalPropertyTypes`) and enforced package boundaries.

| Technology | How it is used |
| --- | --- |
| **TypeScript** | End-to-end language for API, worker, domain packages, and shared contracts |
| **Hono** | HTTP framework for `/api/v1` — webhooks, REST, and SSE with raw-body intake and typed handlers |
| **Next.js + React** | Control-plane web UI; talks to the API via cookie-authenticated, CSRF-protected clients |
| **PostgreSQL** | Authoritative store for policy, approvals, workflows, audit events, and repository state |
| **Redis + worker queue** | Background job dispatch for workflow orchestration and provider calls |
| **Zod** | Runtime validation and shared schema definitions across API contracts and services |
| **Vitest** | Unit, integration, and gated end-to-end test suites |
| **TrueForge** | Sandboxed execution environment — generated code never runs on the DevGuard host |
| **GitHub App** | Repository access, webhooks, issues, pull requests, checks, and review interactions |

Object storage backs large artifacts (logs, scan outputs, sandbox bundles). Local development runs Postgres and Redis via Docker Compose.

---

## Repository layout

```text
apps/
  api/      HTTP transport and webhook intake
  worker/   Queue consumers, workflow orchestration, provider calls
  web/      Next.js operator UI
packages/   Domain modules and adapters (contracts, policy, approvals, GitHub, agent, sandbox, queue, …)
tests/
  integration/  In-process suites with fakes and architecture gates
  e2e/          Gated cross-system suites (`pnpm test:e2e`)
docs/architecture/  Engineering architecture and ADRs
```

Each package under `packages/` is a versioned, boundary-checked module. `pnpm lint` enforces the dependency matrix so domain logic never imports transport or provider SDKs directly.

---

## Getting started

Requires **Node 26**, **pnpm 10** (via Corepack), and **Docker** with Compose v2.

```bash
pnpm install
pnpm local
```

`pnpm local` starts Postgres and Redis, applies migrations, and launches the API (`:4000`) and worker. Provider capabilities (GitHub, TrueForge) are reported honestly — disabled when credentials are absent, not faked as healthy.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Strict project-reference type check |
| `pnpm lint` | ESLint + dependency-boundary gate |
| `pnpm test` | Unit and in-process integration suites |
| `pnpm test:e2e` | Gated end-to-end suites |
| `pnpm local:status` | Container, API, and provider health summary |

Copy `.env.example` to `.env.local` and add GitHub App and TrueForge credentials to enable live provider integrations.

---

## Safety model

- Repository policy and autonomy levels define what the agent may do.
- Unknown or ambiguous actions **fail closed**.
- High-risk operations require durable human approval bound to the exact proposed action and target-state fingerprint.
- Generated code executes only inside a TrueForge sandbox.
- Repository instructions are untrusted and cannot override DevGuard policy.
- Every privileged path is auditable: classify → evaluate policy → persist decision → approve if required → revalidate → execute → verify.

---

## Documentation

- [Architecture](docs/architecture/README.md) — engineering architecture and ADRs
- [Demo video](marketing/demo-video/) — product overview (~2:36)

---

## License

Proprietary. All rights reserved.

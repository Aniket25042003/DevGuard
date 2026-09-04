# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Engineering leads and maintainers working as a team across multiple GitHub repositories. Leads define repository policy and the agent's work style; maintainers supervise runs, review evidence, and authorize privileged actions.

## Product Purpose

DevGuard is a GitHub-focused control plane for governed autonomous software engineering. It gives teams one place to connect repositories, define policy, launch agent workflows, review approvals, and audit outcomes. Success means a team can move quickly while retaining clear human authority and durable evidence for every consequential action.

## Positioning

DevGuard separates governance from execution: policy and approvals are recorded by DevGuard, agent work runs through TrueForge sandbox environments, GitHub remains the source of truth, and humans authorize exact privileged actions when policy requires it.

## Operating Context

Work starts from the web control plane, CLI, or GitHub events and may involve pull requests, issues, security findings, repository policy, agent sessions, sandbox commands, approvals, artifacts, audit events, and verification results. The product must make queued, running, approval-required, blocked, unavailable, failed, and completed states explicit.

## Capabilities and Constraints

- Built-in workflow concepts include issue implementation, security patching/auditing, and failure diagnosis.
- Repository policy defines autonomy levels, allowed/forbidden actions, approval gates, and validation requirements.
- Unknown or ambiguous actions fail closed; generated code must not execute on the DevGuard host.
- GitHub OAuth provides identity; the GitHub App provides repository access.
- PostgreSQL is the durable source of truth for policy, approvals, runs, evidence, and audit; Redis is transport; TrueForge provides agent and sandbox runtime capabilities.
- The current repository contains deliberate fail-closed/unavailable paths while the execution spine is completed. The frontend must not present unavailable execution as completed work.

## Brand Commitments

The product name is DevGuard. Existing product language emphasizes governed AI engineering, policy, approvals, sandboxed execution, GitHub-native workflows, and human control. Do not invent customer names, benchmarks, pricing, or completed execution claims.

## Evidence on Hand

- Product and architecture documentation in `README.md` and `docs/architecture/`.
- Existing web routes and typed API contracts under `apps/web` and `packages/api-contracts`.
- Demo video at `marketing/demo-video/devguard-launch-demo.mp4`.

## Product Principles

1. The model proposes; DevGuard governs and records.
2. Every consequential action is explainable, fingerprinted, and auditable.
3. Isolation is a product promise: agent code runs in a sandbox, never on the host.
4. Humans authorize exact privileged effects when policy requires it.
5. Missing or unhealthy dependencies are visible and fail closed.

## Accessibility & Inclusion

The web control plane must support keyboard operation, visible focus, screen-reader semantics, reduced motion, responsive layouts, and WCAG AA contrast for all normal text and controls.

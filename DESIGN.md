# DevGuard interface system

## Product direction

DevGuard is a calm operational command center for governed agent work. The
interface should answer three questions quickly: what is happening, why is it
safe, and what needs a human decision. The visual language is intentionally
quiet and technical: graphite surfaces, precise dividers, teal verified state,
amber human gates, and monospace only for identifiers and machine evidence.

## Tokens

- **Canvas:** `#0a0f14` with elevated surfaces between `#111820` and
  `#18222b`; a light-mode token set remains available for system preference.
- **Accent:** teal `#27c9ac` for primary actions, focus, verified state, and
  links. It is paired with a soft translucent accent fill rather than a neon
  glow.
- **Risk:** amber for approvals and policy gates; red for failures and unsafe
  states; blue for informational provider/readiness states.
- **Type:** system sans for UI copy, system monospace for IDs, hashes, refs,
  and event payloads. No runtime Google Fonts dependency.
- **Shape:** 10px evidence panels, 8px controls, 1px borders, restrained
  shadows. Cards are reserved for evidence, decisions, and state—not every
  section.

## Layout rules

The authenticated shell uses a persistent repository context, grouped
navigation (workspace, repository, system), a sticky top bar, and a compact
status strip. The first viewport prioritizes the next operator action:

1. repository identity and launch action;
2. pending approvals and active runs;
3. launch targets and recent run history;
4. evidence, policy, and settings deeper in the hierarchy.

On small screens the shell becomes a modal drawer with an explicit menu button,
focus management, Escape-to-close, and a backdrop. Dense tables scroll inside
their own region rather than forcing page-level horizontal overflow.

## Interaction language

- Buttons have a single clear verb and a visible disabled/loading state.
- Primary actions are teal, destructive or high-risk actions are never hidden
  behind ambiguous icon-only controls, and every icon-only control has a label.
- Workflow launch is a two-step interaction: choose a target, then review the
  exact command, repository, origin, and idempotency behavior before submit.
- Approval cards show the operation, target, risk class, rationale, expiry, and
  the server re-check promise before the approve/reject controls.
- Relative timestamps are paired with a full `title` and machine-readable
  `<time>` value.

## Motion and feedback

Motion is short and functional: a 180ms surface transition, a restrained
status-pulse for active work, and a 220ms drawer transition. There are no
decorative parallax effects or looping gradients. `prefers-reduced-motion`
disables transitions and animation. Loading uses structural skeletons; errors
use a status strip with a recovery action and request ID where available.

## Page composition

- **Public landing:** one claim, one GitHub CTA, and a concrete governed-run
  diagram (intent → policy gate → TrueForge sandbox → human approval →
  verified outcome).
- **Repository dashboard:** “Needs your decision”, “Agents working now”,
  launch targets, then run history with origin/status filters.
- **Run detail:** server-confirmed status strip, event rail, approval gate,
  artifacts, findings, and explicit unavailable/session-not-attached states.
- **Policy editor:** draft and canonical preview are visibly distinct; stale
  digest or server validation errors clear after edits and require a fresh
  validation before saving.
- **Preflight/settings/errors:** readiness is rendered as a table of explicit
  healthy/degraded/unavailable states with remediation copy.

## Accessibility contract

All interactive controls are keyboard reachable with a visible focus ring.
Dialogs expose `role="dialog"`, an accessible label, Escape handling, and
initial focus. Lists and filters have labels, status is not conveyed by color
alone, and contrast is checked against both dark and light token sets.

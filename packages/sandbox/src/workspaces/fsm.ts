/**
 * C041 §9 — the workspace lifecycle FSM as an exhaustive transition table.
 *
 * States and legal edges live HERE only. Every non-listed (from, trigger)
 * pair is `WORKSPACE_ILLEGAL_TRANSITION` (fail closed). Only DESTROYED is
 * terminal: FAILED/QUARANTINED are cleanup-required, never proof of
 * destruction, and may only leave toward DESTROYING. READY requires exact
 * SHA equality plus a completed checkout attestation (guards, not model text).
 */
import { makeError } from '@devguard/errors';

export const WORKSPACE_STATUSES = [
  'REQUESTED',
  'PROVISIONING',
  'CHECKING_OUT',
  'VERIFYING',
  'READY',
  'DESTROYING',
  'DESTROYED',
  'FAILED',
  'QUARANTINED',
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_TERMINAL_STATUSES: readonly WorkspaceStatus[] = Object.freeze(['DESTROYED']);

export const WORKSPACE_CLEANUP_REQUIRED_STATUSES: readonly WorkspaceStatus[] = Object.freeze([
  'FAILED',
  'QUARANTINED',
]);

export function isTerminalWorkspace(status: WorkspaceStatus): boolean {
  return WORKSPACE_TERMINAL_STATUSES.includes(status);
}

/** FAILED/QUARANTINED still owe durable cleanup; DESTROYED does not. */
export function workspaceCleanupRequired(status: WorkspaceStatus): boolean {
  return WORKSPACE_CLEANUP_REQUIRED_STATUSES.includes(status);
}

export type WorkspaceTrigger =
  | 'begin-provisioning'
  | 'provision-complete'
  | 'checkout-complete'
  | 'verify-ok'
  | 'verify-fail'
  | 'fail'
  | 'quarantine'
  | 'begin-destroy'
  | 'destroy-confirmed'
  | 'destroy-uncertain';

/**
 * Guard inputs. Every boolean is optional at the TYPE level so callers must
 * opt in explicitly, but the FSM treats any missing guard as FALSE (fail
 * closed): an absent capability proof is a capability failure.
 */
export interface WorkspaceTransitionGuards {
  readonly fenceValid?: boolean | undefined;
  readonly cancellationRequested?: boolean | undefined;
  readonly capabilitiesVerified?: boolean | undefined;
  readonly providerWorkspaceCreated?: boolean | undefined;
  readonly safeCheckoutApplied?: boolean | undefined;
  readonly headMatchesResolvedSha?: boolean | undefined;
  readonly remoteIdentityVerified?: boolean | undefined;
  readonly attestationComplete?: boolean | undefined;
  readonly verificationFailed?: boolean | undefined;
  readonly failureKnown?: boolean | undefined;
  readonly providerAmbiguity?: boolean | undefined;
  readonly providerProvesDestroyed?: boolean | undefined;
  readonly cleanupAttemptsExhausted?: boolean | undefined;
}

export interface WorkspaceTransitionVerdict {
  readonly allowed: boolean;
  readonly to?: WorkspaceStatus | undefined;
  readonly reason: string;
}

function g(guards: WorkspaceTransitionGuards, key: keyof WorkspaceTransitionGuards): boolean {
  return guards[key] === true;
}

type Edge = {
  readonly from: WorkspaceStatus;
  readonly to: WorkspaceStatus;
  readonly guard: string;
};

const LEGAL_EDGES: Readonly<Record<WorkspaceTrigger, readonly Edge[]>> = Object.freeze({
  'begin-provisioning': [
    {
      from: 'REQUESTED',
      to: 'PROVISIONING',
      guard: 'fence valid + no cancellation + capabilities/isolation verified',
    },
  ],
  'provision-complete': [
    {
      from: 'PROVISIONING',
      to: 'CHECKING_OUT',
      guard: 'fence valid + provider workspace created under stable idempotency key',
    },
  ],
  'checkout-complete': [
    {
      from: 'CHECKING_OUT',
      to: 'VERIFYING',
      guard: 'fence valid + safe checkout plan applied + observed HEAD captured',
    },
  ],
  'verify-ok': [
    {
      from: 'VERIFYING',
      to: 'READY',
      guard: 'fence valid + exact SHA equality + remote identity + attestation complete',
    },
  ],
  'verify-fail': [
    {
      from: 'VERIFYING',
      to: 'QUARANTINED',
      guard: 'checkout mismatch observed; workspace must never be used',
    },
  ],
  fail: [
    { from: 'REQUESTED', to: 'FAILED', guard: 'known, non-ambiguous normalized failure' },
    { from: 'PROVISIONING', to: 'FAILED', guard: 'known, non-ambiguous normalized failure' },
    { from: 'CHECKING_OUT', to: 'FAILED', guard: 'known, non-ambiguous normalized failure' },
    {
      from: 'VERIFYING',
      to: 'FAILED',
      guard: 'known, non-ambiguous normalized failure (e.g. REF_CHANGED)',
    },
  ],
  quarantine: [
    { from: 'PROVISIONING', to: 'QUARANTINED', guard: 'provider create/inspect outcome ambiguous' },
    { from: 'CHECKING_OUT', to: 'QUARANTINED', guard: 'provider checkout outcome ambiguous' },
    { from: 'VERIFYING', to: 'QUARANTINED', guard: 'provider verification outcome ambiguous' },
    {
      from: 'DESTROYING',
      to: 'QUARANTINED',
      guard: 'destruction attempts exhausted, still unproven',
    },
  ],
  'begin-destroy': [
    {
      from: 'REQUESTED',
      to: 'DESTROYING',
      guard: 'fence valid or durable cancellation; lifecycle end',
    },
    { from: 'PROVISIONING', to: 'DESTROYING', guard: 'fence valid or durable cancellation' },
    { from: 'CHECKING_OUT', to: 'DESTROYING', guard: 'fence valid or durable cancellation' },
    { from: 'VERIFYING', to: 'DESTROYING', guard: 'fence valid or durable cancellation' },
    { from: 'READY', to: 'DESTROYING', guard: 'fence valid or durable cancellation; run complete' },
    { from: 'FAILED', to: 'DESTROYING', guard: 'durable cleanup of failed workspace' },
    { from: 'QUARANTINED', to: 'DESTROYING', guard: 'retry destruction of quarantined workspace' },
  ],
  'destroy-confirmed': [
    {
      from: 'DESTROYING',
      to: 'DESTROYED',
      guard: 'provider proves workspace is gone (inspection, not assumption)',
    },
  ],
  'destroy-uncertain': [
    {
      from: 'DESTROYING',
      to: 'QUARANTINED',
      guard: 'provider cannot prove destruction after exhausted attempts; never claim cleaned',
    },
  ],
});

export function isLegalWorkspaceEdge(
  from: WorkspaceStatus,
  trigger: WorkspaceTrigger,
): Edge | undefined {
  return LEGAL_EDGES[trigger].find((edge) => edge.from === from);
}

/** Pure transition lookup; missing guards fail closed (treated as false). */
export function resolveWorkspaceEdge(
  from: WorkspaceStatus,
  trigger: WorkspaceTrigger,
  guards: WorkspaceTransitionGuards,
): WorkspaceTransitionVerdict {
  if (isTerminalWorkspace(from)) {
    return { allowed: false, reason: `workspace is terminal in '${from}'` };
  }
  const edge = isLegalWorkspaceEdge(from, trigger);
  if (!edge) {
    return { allowed: false, reason: `illegal transition ${from} --${trigger}--> (none)` };
  }

  switch (trigger) {
    case 'begin-provisioning':
      return g(guards, 'fenceValid') &&
        !g(guards, 'cancellationRequested') &&
        g(guards, 'capabilitiesVerified')
        ? allowed(edge)
        : denied(edge, 'fence, cancellation, or capability/isolation proof missing');
    case 'provision-complete':
      return g(guards, 'fenceValid') &&
        !g(guards, 'cancellationRequested') &&
        g(guards, 'providerWorkspaceCreated')
        ? allowed(edge)
        : denied(edge, 'fence or stable provider creation not proven');
    case 'checkout-complete':
      return g(guards, 'fenceValid') &&
        !g(guards, 'cancellationRequested') &&
        g(guards, 'safeCheckoutApplied')
        ? allowed(edge)
        : denied(edge, 'fence or safe checkout application not proven');
    case 'verify-ok':
      return g(guards, 'fenceValid') &&
        !g(guards, 'cancellationRequested') &&
        g(guards, 'headMatchesResolvedSha') &&
        g(guards, 'remoteIdentityVerified') &&
        g(guards, 'attestationComplete')
        ? allowed(edge)
        : denied(edge, 'READY requires exact SHA equality, remote identity, and attestation');
    case 'verify-fail':
      return g(guards, 'verificationFailed')
        ? allowed(edge)
        : denied(edge, 'verification failure not observed');
    case 'fail':
      return g(guards, 'failureKnown') &&
        (g(guards, 'fenceValid') || g(guards, 'cancellationRequested'))
        ? allowed(edge)
        : denied(edge, 'known failure with valid fence or cancellation required');
    case 'quarantine':
      return g(guards, 'providerAmbiguity')
        ? allowed(edge)
        : denied(edge, 'provider outcome ambiguity not established');
    case 'begin-destroy':
      return g(guards, 'fenceValid') || g(guards, 'cancellationRequested')
        ? allowed(edge)
        : denied(edge, 'begin-destroy requires a valid fence or durable cancellation');
    case 'destroy-confirmed':
      return g(guards, 'providerProvesDestroyed')
        ? allowed(edge)
        : denied(edge, 'provider must prove absence before DESTROYED');
    case 'destroy-uncertain':
      return !g(guards, 'providerProvesDestroyed') && g(guards, 'cleanupAttemptsExhausted')
        ? allowed(edge)
        : denied(edge, 'destruction uncertainty requires exhausted cleanup attempts');
  }
}

function allowed(edge: Edge): WorkspaceTransitionVerdict {
  return { allowed: true, to: edge.to, reason: 'guard satisfied' };
}

function denied(edge: Edge, reason: string): WorkspaceTransitionVerdict {
  return { allowed: false, to: edge.to, reason: `${edge.guard}; ${reason}` };
}

/**
 * Fenced transition helper used by the manager and jobs: throws
 * WORKSPACE_ILLEGAL_TRANSITION (C041 §9) instead of returning a verdict.
 */
export function transitionWorkspace(
  from: WorkspaceStatus,
  trigger: WorkspaceTrigger,
  guards: WorkspaceTransitionGuards,
): WorkspaceStatus {
  const verdict = resolveWorkspaceEdge(from, trigger, guards);
  if (!verdict.allowed || verdict.to === undefined) {
    throw makeError('WORKSPACE_ILLEGAL_TRANSITION', {
      details: { from, trigger },
    });
  }
  return verdict.to;
}

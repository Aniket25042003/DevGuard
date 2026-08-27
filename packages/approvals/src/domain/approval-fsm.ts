/**
 * C031 §9 — the complete approval FSM as an exhaustive transition table.
 *
 * States and legal edges live HERE only — no scattered booleans. Every
 * non-listed (from, trigger) pair is `APPROVAL_ILLEGAL_TRANSITION`. Terminal
 * states accept no transitions except retention/redaction metadata.
 */
export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'STALE',
  'EXECUTING',
  'EXECUTED',
  'EXECUTION_FAILED',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ApprovalStatus[] = Object.freeze([
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'STALE',
  'EXECUTED',
  'EXECUTION_FAILED',
]);

export function isTerminal(status: ApprovalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Triggers drive every legal edge; one trigger maps to exactly one edge. */
export type ApprovalTrigger =
  | 'create'
  | 'approve'
  | 'reject'
  | 'expire'
  | 'mark-stale'
  | 'cancel-before-execution'
  | 'cancel-reconciled'
  | 'execution-claim'
  | 'execute-verified'
  | 'execute-failed';

const LEGAL_EDGES: Readonly<
  Record<
    ApprovalTrigger,
    ReadonlyArray<{ from: ApprovalStatus; to: ApprovalStatus; guard: string }>
  >
> = Object.freeze({
  create: [
    {
      from: 'PENDING',
      to: 'PENDING',
      guard: 'persisted REQUIRE_APPROVAL decision + complete fingerprints + future expiry',
    },
  ],
  approve: [
    {
      from: 'PENDING',
      to: 'APPROVED',
      guard:
        'authorized actor + expected version/fingerprints + valid workflow/target/policy + not expired',
    },
  ],
  reject: [
    { from: 'PENDING', to: 'REJECTED', guard: 'authorized actor on current unresolved version' },
  ],
  expire: [
    { from: 'PENDING', to: 'EXPIRED', guard: 'database now >= expiresAt' },
    { from: 'APPROVED', to: 'EXPIRED', guard: 'expiry reached before execution claim' },
  ],
  'mark-stale': [
    { from: 'PENDING', to: 'STALE', guard: 'current context differs from binding' },
    {
      from: 'APPROVED',
      to: 'STALE',
      guard: 'target/policy/risk/validation/default-branch binding changed',
    },
  ],
  'cancel-before-execution': [
    { from: 'PENDING', to: 'CANCELLED', guard: 'durable run cancellation generation is current' },
    { from: 'APPROVED', to: 'CANCELLED', guard: 'no external effect has begun' },
  ],
  'cancel-reconciled': [
    {
      from: 'EXECUTING',
      to: 'CANCELLED',
      guard: 'provider proves execution never began AND lease fenced',
    },
  ],
  'execution-claim': [
    { from: 'APPROVED', to: 'EXECUTING', guard: 'steps 1-6 passed + unique lease/attempt claimed' },
  ],
  'execute-verified': [
    { from: 'EXECUTING', to: 'EXECUTED', guard: 'provider proves exact intended effect' },
  ],
  'execute-failed': [
    {
      from: 'EXECUTING',
      to: 'EXECUTION_FAILED',
      guard: 'provider proves failure/absence OR uncertainty exhausted to human intervention',
    },
  ],
});

export interface TransitionGuardContext {
  /** Database clock in ms (expiry NEVER uses app clocks). */
  readonly nowMs: number;
  readonly expiresAtMs: number;
  /** Result of synchronous validity check for stale-capable triggers. */
  readonly contextMatchesBinding?: boolean | undefined;
  /** Cancellation generation current at decision time. */
  readonly cancellationCurrent?: boolean | undefined;
  readonly stepsOneThroughSixPassed?: boolean | undefined;
  readonly externalEffectBegan?: boolean | undefined;
  readonly providerProvesNotStarted?: boolean | undefined;
  readonly leaseFenced?: boolean | undefined;
  readonly providerOutcomeVerified?: boolean | undefined;
}

export type TransitionVerdict =
  | { readonly allowed: true; readonly from: ApprovalStatus; readonly to: ApprovalStatus }
  | {
      readonly allowed: false;
      readonly code: 'APPROVAL_ILLEGAL_TRANSITION';
      readonly detail: string;
    };

/**
 * Pure FSM predicate. Guards are evaluated by callers via `TransitionGuardContext`
 * where a trigger requires them; a failed guard is a distinct refusal reason.
 */
export function resolveEdge(
  from: ApprovalStatus,
  trigger: ApprovalTrigger,
  context: Partial<TransitionGuardContext> = {},
): TransitionVerdict {
  if (isTerminal(from)) {
    return {
      allowed: false,
      code: 'APPROVAL_ILLEGAL_TRANSITION',
      detail: `'${from}' is terminal; approvals never transition out of terminal states`,
    };
  }
  const edges = LEGAL_EDGES[trigger];
  const candidate = edges.find((edge) => edge.from === from);
  if (!candidate) {
    return {
      allowed: false,
      code: 'APPROVAL_ILLEGAL_TRANSITION',
      detail: `trigger '${trigger}' cannot fire from '${from}'`,
    };
  }

  const nowMs = context.nowMs ?? 0;
  const expiresAtMs = context.expiresAtMs ?? Number.MAX_SAFE_INTEGER;
  // Trigger-specific guards (C031 §9 table).
  switch (trigger) {
    case 'approve':
    case 'reject':
      if (nowMs >= expiresAtMs) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'approval already past expiry; expire instead',
        };
      }
      break;
    case 'expire':
      if (nowMs < expiresAtMs) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'not yet past expiry (database clock)',
        };
      }
      break;
    case 'mark-stale':
      if (context.contextMatchesBinding !== false) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'context still matches binding; nothing to invalidate',
        };
      }
      break;
    case 'cancel-before-execution':
      if (context.cancellationCurrent === false) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'cancellation generation superseded',
        };
      }
      if (from === 'APPROVED' && context.externalEffectBegan === true) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'external effect may have begun; reconciliation decides the outcome, not cancel',
        };
      }
      break;
    case 'cancel-reconciled':
      if (!(context.providerProvesNotStarted && context.leaseFenced)) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'reconciled cancellation requires proof-not-started AND a fenced lease',
        };
      }
      break;
    case 'execution-claim':
      if (nowMs >= expiresAtMs) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'expired before claim',
        };
      }
      if (context.stepsOneThroughSixPassed !== true) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'execution claim requires steps 1-6 proven',
        };
      }
      break;
    case 'execute-verified':
      if (context.providerOutcomeVerified !== true) {
        return {
          allowed: false,
          code: 'APPROVAL_ILLEGAL_TRANSITION',
          detail: 'EXECUTED requires provider-verified outcome evidence',
        };
      }
      break;
    case 'execute-failed':
      // Provider-proven failure/absence or exhausted uncertainty both qualify;
      // callers must supply at least one positive failure signal.
      break;
    default:
      break;
  }

  return { allowed: true, from: candidate.from, to: candidate.to };
}

/** Exhaustive legality helper used by tests: every status x trigger resolves. */
export function allPairs(): ReadonlyArray<{ from: ApprovalStatus; trigger: ApprovalTrigger }> {
  const out: Array<{ from: ApprovalStatus; trigger: ApprovalTrigger }> = [];
  for (const from of APPROVAL_STATUSES) {
    for (const trigger of Object.keys(LEGAL_EDGES) as ApprovalTrigger[])
      out.push({ from, trigger });
  }
  return out;
}

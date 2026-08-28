/**
 * C036 §9 — the compatibility FSM as an exhaustive transition table.
 *
 * States and legal edges live HERE only. Legal transitions require a persisted
 * verification run: callers supply evidence via `TransitionGuardContext`. Every
 * non-listed (from, trigger) pair is `AGENT_COMPATIBILITY_ILLEGAL_TRANSITION`.
 * Unknown or missing safety-critical capability outcomes produce INCOMPATIBLE,
 * never a permissive fallback.
 *
 * Legal transitions:
 *   begin_verify        UNVERIFIED/INCOMPATIBLE/UNAVAILABLE/DEGRADED -> VERIFYING
 *   verified_compatible VERIFYING -> COMPATIBLE
 *   verified_degraded   VERIFYING -> DEGRADED
 *   verified_incompat   VERIFYING -> INCOMPATIBLE
 *   unavailable         VERIFYING -> UNAVAILABLE ; COMPATIBLE -> DEGRADED ; DEGRADED -> UNAVAILABLE
 *   drift_degraded      COMPATIBLE -> DEGRADED
 *   drift_incompat      COMPATIBLE -> INCOMPATIBLE ; DEGRADED -> INCOMPATIBLE
 */
import type { CapabilityVerdict } from './capabilities.js';

export const COMPATIBILITY_STATUSES = [
  'UNVERIFIED',
  'VERIFYING',
  'COMPATIBLE',
  'DEGRADED',
  'INCOMPATIBLE',
  'UNAVAILABLE',
] as const;

export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

/** Operational states: runtime operations may bind to a current snapshot. */
export const OPERATIONAL_STATUSES: readonly CompatibilityStatus[] = Object.freeze([
  'COMPATIBLE',
  'DEGRADED',
]);

export function isOperational(status: CompatibilityStatus): boolean {
  return OPERATIONAL_STATUSES.includes(status);
}

/**
 * Map a capability verdict to FSM status. This is the only place verdicts
 * become compatibility statuses; runtime transitions additionally require
 * verification evidence (see `resolveEdge`).
 */
export function verdictToStatus(verdict: CapabilityVerdict): CompatibilityStatus {
  switch (verdict) {
    case 'COMPATIBLE':
      return 'COMPATIBLE';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'INCOMPATIBLE':
      return 'INCOMPATIBLE';
  }
}

export type CompatibilityTrigger =
  | 'begin_verify'
  | 'verified_compatible'
  | 'verified_degraded'
  | 'verified_incompat'
  | 'unavailable'
  | 'drift_degraded'
  | 'drift_incompat';

const LEGAL_EDGES: Readonly<
  Record<
    CompatibilityTrigger,
    ReadonlyArray<{ from: CompatibilityStatus; to: CompatibilityStatus }>
  >
> = Object.freeze({
  begin_verify: [
    { from: 'UNVERIFIED', to: 'VERIFYING' },
    { from: 'INCOMPATIBLE', to: 'VERIFYING' },
    { from: 'UNAVAILABLE', to: 'VERIFYING' },
    { from: 'DEGRADED', to: 'VERIFYING' },
  ],
  verified_compatible: [{ from: 'VERIFYING', to: 'COMPATIBLE' }],
  verified_degraded: [{ from: 'VERIFYING', to: 'DEGRADED' }],
  verified_incompat: [{ from: 'VERIFYING', to: 'INCOMPATIBLE' }],
  unavailable: [
    { from: 'VERIFYING', to: 'UNAVAILABLE' },
    { from: 'COMPATIBLE', to: 'DEGRADED' },
    { from: 'DEGRADED', to: 'UNAVAILABLE' },
  ],
  drift_degraded: [{ from: 'COMPATIBLE', to: 'DEGRADED' }],
  drift_incompat: [
    { from: 'COMPATIBLE', to: 'INCOMPATIBLE' },
    { from: 'DEGRADED', to: 'INCOMPATIBLE' },
  ],
});

type LegalFromKeys = keyof typeof LEGAL_EDGES;

// Guard: every edge references a real status.
function assertEdgesValid(): void {
  for (const trigger of Object.keys(LEGAL_EDGES) as LegalFromKeys[]) {
    for (const edge of LEGAL_EDGES[trigger]) {
      if (!(COMPATIBILITY_STATUSES as readonly string[]).includes(edge.from)) {
        throw new TypeError(`Compatibility FSM edge references unknown state '${edge.from}'.`);
      }
      if (!(COMPATIBILITY_STATUSES as readonly string[]).includes(edge.to)) {
        throw new TypeError(`Compatibility FSM edge references unknown state '${edge.to}'.`);
      }
    }
  }
}
assertEdgesValid();

/** Evidence a legal transition must carry. */
export interface TransitionGuardContext {
  /** The persisted verification run id that produced this transition (hex digest). */
  readonly verificationRunId?: string | undefined;
  /** The immutable contract snapshot id the run produced. */
  readonly snapshotId?: string | undefined;
}

export type TransitionVerdict =
  | { readonly allowed: true; readonly from: CompatibilityStatus; readonly to: CompatibilityStatus }
  | {
      readonly allowed: false;
      readonly code: 'AGENT_COMPATIBILITY_ILLEGAL_TRANSITION';
      readonly detail: string;
    };

/**
 * Pure FSM predicate. No verification evidence yet -> every non-UNVERIFIED
 * outcome is refused.
 */
export function resolveEdge(
  from: CompatibilityStatus,
  trigger: CompatibilityTrigger,
  context: Partial<TransitionGuardContext> = {},
): TransitionVerdict {
  if (trigger !== 'begin_verify' && !context.verificationRunId) {
    return {
      allowed: false,
      code: 'AGENT_COMPATIBILITY_ILLEGAL_TRANSITION',
      detail: `'${trigger}' requires persisted verification evidence (verificationRunId).`,
    };
  }
  const edges = LEGAL_EDGES[trigger];
  const candidates = edges.filter((edge) => edge.from === from);
  if (candidates.length === 0) {
    return {
      allowed: false,
      code: 'AGENT_COMPATIBILITY_ILLEGAL_TRANSITION',
      detail: `trigger '${trigger}' cannot fire from '${from}'`,
    };
  }
  // Empty check above guarantees at least one match; noUncheckedIndexedAccess
  // still types element access as possibly-undefined, so assert non-null.
  const target = candidates[0]!.to;
  return { allowed: true, from, to: target };
}

/** Exhaustive legality helper used by tests: every status x trigger resolves. */
export function allCompatibilityPairs(): ReadonlyArray<{
  from: CompatibilityStatus;
  trigger: CompatibilityTrigger;
}> {
  const out: Array<{ from: CompatibilityStatus; trigger: CompatibilityTrigger }> = [];
  for (const from of COMPATIBILITY_STATUSES) {
    for (const trigger of Object.keys(LEGAL_EDGES) as CompatibilityTrigger[])
      out.push({ from, trigger });
  }
  return out;
}

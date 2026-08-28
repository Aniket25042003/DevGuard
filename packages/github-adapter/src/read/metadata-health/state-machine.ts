/**
 * C014 §9 — explicit health/readiness state machine.
 *
 * Health states move only on current evidence; `unknown` means no evidence
 * yet. The machine rejects transitions that contradict evidence (e.g. a
 * `healthy` claim while the default branch is unresolved) rather than
 * silently inventing a state.
 */
import { exhaustiveMatch } from '@devguard/contracts';
import type { HealthStatus, ReadinessStatus } from './contracts.js';

/** Evidence gates a transition must satisfy (C014 §9 guards). */
export interface HealthTransitionEvidence {
  readonly lifecycleConnected: boolean;
  readonly lifecycleDegraded: boolean;
  readonly lifecycleDisconnected: boolean;
  readonly requiredPermissionsMet: boolean;
  readonly defaultBranchResolved: boolean;
  /** Non-expired critical metadata captured within freshness budget. */
  readonly criticalMetadataFresh: boolean;
  /** At least one provider read succeeded in this evaluation window. */
  readonly providerReachable: boolean;
  /** All provider reads failed with provider-level errors. */
  readonly providerUnreachable: boolean;
}

export type HealthTransitionVerdict =
  | { readonly allowed: true; readonly target: HealthStatus }
  | {
      readonly allowed: false;
      readonly reason: 'NO_EVIDENCE' | 'GUARD_UNMET' | 'CONTRADICTS_EVIDENCE';
    };

/**
 * Deterministic transition function. Any status may move to any other status
 * when the evidence supports it; transitions without supporting evidence are
 * rejected, never guessed.
 */
export function evaluateHealthTransition(
  target: HealthStatus,
  evidence: HealthTransitionEvidence,
): HealthTransitionVerdict {
  switch (target) {
    case 'unknown':
      // Only reachable while no evidence exists at all.
      return evidence.providerReachable || evidence.providerUnreachable
        ? { allowed: false, reason: 'CONTRADICTS_EVIDENCE' }
        : { allowed: true, target };
    case 'unavailable':
      // Confirmed inability to access required provider state.
      return evidence.providerUnreachable || evidence.lifecycleDisconnected
        ? { allowed: true, target }
        : { allowed: false, reason: 'GUARD_UNMET' };
    case 'degraded':
      // Anything observable but not fully healthy: partial failure, stale
      // evidence, degraded lifecycle, or unmet health guard.
      return evidence.providerReachable || evidence.lifecycleDegraded
        ? { allowed: true, target }
        : { allowed: false, reason: 'NO_EVIDENCE' };
    case 'healthy':
      // All C014 §9 guards: active lifecycle, required permissions,
      // resolvable default branch, non-expired critical metadata.
      return evidence.lifecycleConnected &&
        evidence.requiredPermissionsMet &&
        evidence.defaultBranchResolved &&
        evidence.criticalMetadataFresh &&
        evidence.providerReachable
        ? { allowed: true, target }
        : { allowed: false, reason: 'GUARD_UNMET' };
  }
}

/**
 * Readiness is derived from the same evidence (C014 §9): `blocked` forbids
 * workflow start, `read_only` may allow advisory reads, `ready` requires all
 * mutation prerequisites. Readiness is evidence, never authorization.
 */
export function evaluateReadiness(
  status: HealthStatus,
  evidence: HealthTransitionEvidence,
): ReadinessStatus {
  return exhaustiveMatch(status, {
    unknown: () => 'blocked' as ReadinessStatus,
    unavailable: () => 'blocked' as ReadinessStatus,
    degraded: () => 'read_only' as ReadinessStatus,
    healthy: () => {
      if (!evidence.requiredPermissionsMet || !evidence.defaultBranchResolved) {
        return 'blocked';
      }
      // A healthy read snapshot with stale critical metadata degrades
      // mutation readiness, but advisory reads remain allowed.
      return evidence.criticalMetadataFresh ? 'ready' : 'read_only';
    },
  });
}

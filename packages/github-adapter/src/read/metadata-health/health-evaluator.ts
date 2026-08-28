/**
 * C014 §23 step 5 — deterministic health evaluator.
 *
 * Pure function: evidence in, health snapshot out. No model/prose decisions.
 * The truth table is explicit and exhausted; unknown situations produce
 * `unknown`/`blocked`, never guessed health. `blocked` readiness prevents
 * unsafe workflow start but is not itself action authorization (C014 §9/§25).
 */
import type {
  HealthDimension,
  HealthDimensions,
  HealthReasonCode,
  HealthStatus,
  MetadataField,
  ReadinessStatus,
  RepositoryHealthSnapshot,
} from './contracts.js';
import type { CollectedFields } from './collectors.js';
import type { RepositoryLifecycleStatus } from '../lifecycle.js';
import { evaluateHealthTransition, type HealthTransitionEvidence } from './state-machine.js';

/** Critical metadata fields: workflow preflight cannot proceed without them. */
export const CRITICAL_METADATA_FIELDS: readonly MetadataField[] = ['identity', 'default_branch'];

/** Hard staleness boundary beyond which cached values are unusable. */
export const METADATA_HARD_STALE_MS = 24 * 60 * 60 * 1000;

export interface HealthEvaluationInput {
  readonly repositoryDevguardId: string;
  readonly lifecycleStatus: RepositoryLifecycleStatus | 'unknown';
  readonly requiredPermissionsMet: boolean;
  readonly collected: CollectedFields;
  /** Freshness budget captured with the snapshot (validUntil boundary). */
  readonly nowIso: string;
  readonly nowMs: number;
  readonly validUntilMs: number;
  readonly capturedAtMs: number;
  readonly computedVersion: number;
}

interface RawDecision {
  readonly status: HealthStatus;
  readonly readiness: ReadinessStatus;
  readonly reasonCode: HealthReasonCode;
}

function dim(
  status: HealthDimension['status'],
  reasonCode: HealthReasonCode,
  observedAtIso: string,
  extra?: { evidenceRef?: string | undefined; remediation?: string | undefined },
): HealthDimension {
  return {
    status,
    reasonCode,
    observedAtIso,
    ...(extra?.evidenceRef !== undefined ? { evidenceRef: extra.evidenceRef } : {}),
    ...(extra?.remediation !== undefined ? { remediation: extra.remediation } : {}),
  };
}

/**
 * Evaluates a single health snapshot from collected evidence. Deterministic:
 * the same evidence always yields the same status, readiness, and reason.
 */
export class HealthEvaluator {
  evaluate(input: HealthEvaluationInput): RepositoryHealthSnapshot {
    const c = input.collected;
    const attempted = c.attemptedFields;
    const hasCriticalFresh =
      (c.identity?.defaultBranch ?? '').length > 0 && c.identity !== undefined;
    const evidence: HealthTransitionEvidence = {
      lifecycleConnected: input.lifecycleStatus === 'connected',
      lifecycleDegraded: input.lifecycleStatus === 'degraded',
      lifecycleDisconnected: input.lifecycleStatus === 'disconnected',
      requiredPermissionsMet: input.requiredPermissionsMet,
      defaultBranchResolved: hasCriticalFresh,
      criticalMetadataFresh: input.nowMs <= input.validUntilMs && hasCriticalFresh,
      providerReachable: c.anySuccess || attempted.length === 0,
      providerUnreachable: c.unreachable && !c.anySuccess,
    };

    const decision = this.#decide(evidence, input, c);

    // The state machine must accept the decision as evidence-backed.
    const verdict = evaluateHealthTransition(decision.status, evidence);
    if (!verdict.allowed) {
      // Fail closed: never emit a state the evidence does not support.
      return this.#snapshot(
        input,
        'unknown',
        'blocked',
        'NO_EVIDENCE_YET',
        this.#dimensions(input, c, evidence, 'unknown'),
      );
    }

    const dimensions = this.#dimensions(input, c, evidence, decision.status);
    return this.#snapshot(
      input,
      decision.status,
      decision.readiness,
      decision.reasonCode,
      dimensions,
    );
  }

  #decide(
    evidence: HealthTransitionEvidence,
    input: HealthEvaluationInput,
    c: CollectedFields,
  ): RawDecision {
    if (evidence.lifecycleDisconnected) {
      return { status: 'unavailable', readiness: 'blocked', reasonCode: 'LIFECYCLE_DISCONNECTED' };
    }
    if (evidence.providerUnreachable && attemptedCount(c) > 0) {
      return { status: 'unavailable', readiness: 'blocked', reasonCode: 'PROVIDER_UNREACHABLE' };
    }
    if (evidence.lifecycleDegraded) {
      return { status: 'degraded', readiness: 'read_only', reasonCode: 'LIFECYCLE_DEGRADED' };
    }
    if (attemptedCount(c) === 0 && input.capturedAtMs === 0) {
      // No evidence and no previous snapshot: honest `unknown`, never invented.
      return { status: 'unknown', readiness: 'blocked', reasonCode: 'NO_EVIDENCE_YET' };
    }
    if (!evidence.requiredPermissionsMet) {
      return { status: 'degraded', readiness: 'blocked', reasonCode: 'MISSING_PERMISSIONS' };
    }
    if (!evidence.defaultBranchResolved) {
      return { status: 'degraded', readiness: 'blocked', reasonCode: 'DEFAULT_BRANCH_MISSING' };
    }
    if (!input.capturedAtMs || c.identity === undefined) {
      return { status: 'degraded', readiness: 'blocked', reasonCode: 'METADATA_NEVER_CAPTURED' };
    }
    const fresh = input.nowMs <= input.validUntilMs;
    if (fresh && evidence.requiredPermissionsMet && evidence.lifecycleConnected) {
      // Checks may be absent without making the repository unhealthy
      // (C014 §27: checks degrade dimensions, not the whole snapshot).
      return { status: 'healthy', readiness: 'ready', reasonCode: 'METADATA_FRESH' };
    }
    return { status: 'degraded', readiness: 'read_only', reasonCode: 'METADATA_STALE' };
  }

  #dimensions(
    input: HealthEvaluationInput,
    c: CollectedFields,
    evidence: HealthTransitionEvidence,
    _status: HealthStatus,
  ): HealthDimensions {
    const nowIso = input.nowIso;
    const hardStale = input.nowMs - input.capturedAtMs > METADATA_HARD_STALE_MS;
    const criticalFieldsOk = evidence.defaultBranchResolved;
    const checksFailed = c.fieldFailures.some((f) => f.field === 'checks');

    const connection: HealthDimension = evidence.providerUnreachable
      ? dim('failed', 'PROVIDER_UNREACHABLE', nowIso, {
          remediation: 'Retry from the provider after recovery.',
        })
      : c.anySuccess || attemptedCount(c) === 0
        ? dim('ok', 'PROVIDER_REACHABLE', nowIso)
        : dim('unknown', 'NO_EVIDENCE_YET', nowIso);

    const authentication: HealthDimension = c.fieldFailures.some(
      (f) => f.reasonCode === 'AUTHENTICATION',
    )
      ? dim('failed', 'AUTHENTICATION_FAILED', nowIso, {
          remediation: 'Re-authorize the installation.',
        })
      : c.anySuccess
        ? dim('ok', 'PROVIDER_REACHABLE', nowIso)
        : dim('unknown', 'NO_EVIDENCE_YET', nowIso);

    const permissions: HealthDimension = evidence.requiredPermissionsMet
      ? dim('ok', 'PERMISSIONS_OK', nowIso)
      : dim('failed', 'MISSING_PERMISSIONS', nowIso, {
          remediation: 'Grant the required installation read permissions.',
        });

    const repository: HealthDimension =
      c.identity !== undefined
        ? dim('ok', 'REPOSITORY_OBSERVED', nowIso)
        : input.capturedAtMs > 0
          ? dim('degraded', 'REPOSITORY_STALE', nowIso)
          : dim('unknown', 'NO_EVIDENCE_YET', nowIso);

    const defaultBranch: HealthDimension = criticalFieldsOk
      ? dim('ok', 'DEFAULT_BRANCH_RESOLVED', nowIso)
      : dim('failed', 'DEFAULT_BRANCH_MISSING', nowIso, {
          remediation: 'Confirm the repository default branch.',
        });

    const metadataFreshness: HealthDimension =
      input.capturedAtMs === 0
        ? dim('failed', 'METADATA_NEVER_CAPTURED', nowIso, {
            remediation: 'Run a metadata refresh.',
          })
        : input.nowMs <= input.validUntilMs
          ? dim('ok', 'METADATA_FRESH', nowIso)
          : hardStale
            ? dim('failed', 'METADATA_HARD_STALE', nowIso)
            : dim('degraded', 'METADATA_STALE', nowIso);

    const checksIntegration: HealthDimension = checksFailed
      ? dim('degraded', 'CHECKS_UNAVAILABLE', nowIso, {
          remediation: 'Review CI check permissions.',
        })
      : c.ciDescriptors !== undefined && c.ciDescriptors.length > 0
        ? dim('ok', 'CHECKS_INTEGRATION_OK', nowIso)
        : dim('unknown', 'CHECKS_UNVERIFIED', nowIso);

    return {
      connection,
      authentication,
      permissions,
      repository,
      defaultBranch,
      metadataFreshness,
      checksIntegration,
    };
  }

  #snapshot(
    input: HealthEvaluationInput,
    status: HealthStatus,
    readiness: ReadinessStatus,
    reasonCode: HealthReasonCode,
    dimensions: HealthDimensions,
  ): RepositoryHealthSnapshot {
    return {
      repositoryDevguardId: input.repositoryDevguardId,
      status,
      readiness,
      dimensions,
      lifecycleStatus: input.lifecycleStatus,
      reasonCode,
      computedVersion: input.computedVersion,
      capturedAtIso: input.nowIso,
      schemaVersion: 1,
    };
  }
}

function attemptedCount(c: CollectedFields): number {
  return c.attemptedFields.length;
}

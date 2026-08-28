/**
 * C048 §9/§10/§12 — validation aggregation, gate, and outcome contract.
 *
 * The aggregate gate is SATISFIED only when every mandatory current validation
 * is PASSED and every required artifact is SAFE. User-facing outcome derives
 * claims only from persisted results/artifacts/actions; it can never claim
 * "passed" without linked PASSED evidence.
 */
import { z } from 'zod';

export const VALIDATION_SCHEMA_VERSION = 1 as const;

export const VALIDATION_ITEM_STATES = [
  'PENDING',
  'READY',
  'RUNNING',
  'COLLECTING_EVIDENCE',
  'RETRY_WAIT',
  'PASSED',
  'FAILED',
  'SKIPPED',
  'BLOCKED',
  'ERROR',
  'STALE',
  'CANCELLING',
  'CANCELLED',
] as const;
export type ValidationItemState = (typeof VALIDATION_ITEM_STATES)[number];

export const GATE_STATES = [
  'PLANNED',
  'RUNNING',
  'EVALUATING',
  'SATISFIED',
  'UNSATISFIED',
  'BLOCKED',
  'STALE',
] as const;
export type GateState = (typeof GATE_STATES)[number];

export interface ValidationResult {
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly status: ValidationItemState;
  readonly mandatory: boolean;
  readonly targetSha: string;
  readonly observedAtIso: string;
  readonly validUntilIso?: string | undefined;
  readonly findingIds: readonly string[];
}

export interface OutcomeEvidenceInput {
  readonly runId: string;
  readonly completedItems: readonly string[];
  readonly notCompletedItems: readonly string[];
  readonly artifactScanStates: Readonly<Record<string, 'SAFE' | 'QUARANTINED' | 'REJECTED'>>;
  readonly requiredArtifactIds: readonly string[];
  readonly prPendingApproval: boolean;
}

export const workflowOutcomeKindSchema = z.enum([
  'success',
  'partial',
  'blocked',
  'failed',
  'cancelled',
  'rejected',
  'timed_out',
]);
export type WorkflowOutcomeKind = z.infer<typeof workflowOutcomeKindSchema>;

export interface WorkflowOutcome {
  readonly runId: string;
  readonly kind: WorkflowOutcomeKind;
  readonly summary: string;
  readonly retryability: 'safe' | 'reconcile' | 'required_user_action' | 'none';
  readonly nextAction: string;
}

export type AggregateVerdict =
  | { readonly gate: 'SATISFIED'; readonly outcome: WorkflowOutcome }
  | { readonly gate: 'UNSATISFIED' | 'BLOCKED' | 'STALE'; readonly outcome: WorkflowOutcome };

export type FreshnessEvaluator = (result: ValidationResult) => boolean;

export const NoopFreshnessEvaluator: FreshnessEvaluator = (result) => {
  const observed = Date.parse(result.observedAtIso);
  const validUntil = result.validUntilIso === undefined ? Number.POSITIVE_INFINITY : Date.parse(result.validUntilIso);
  return Number.isFinite(observed) && observed <= Date.now() && Number.isFinite(validUntil) && validUntil >= Date.now();
};

export class ValidationAggregator {
  constructor(private readonly isFresh: FreshnessEvaluator = NoopFreshnessEvaluator) {}

  aggregate(
    results: readonly ValidationResult[],
    evidence: OutcomeEvidenceInput,
    expectations: { readonly targetSha?: string; readonly validatorIds?: readonly string[] } = {},
  ): AggregateVerdict {
    const bad = results.find((r) => r.status === 'BLOCKED' || r.status === 'ERROR' || (expectations.targetSha !== undefined && r.targetSha !== expectations.targetSha));
    if (expectations.validatorIds?.some((id) => !results.some((r) => r.validatorId === id && r.status === 'PASSED')))
      return { gate: 'UNSATISFIED', outcome: this.#outcome(evidence, 'failed', 'required validation evidence missing', 'required_user_action', 'run required validations') };
    if (bad !== undefined) {
      return {
        gate: 'BLOCKED',
        outcome: this.#outcome(
          evidence,
          'blocked',
          'blocked',
          'required_user_action',
          'resolve blocked validation',
        ),
      };
    }
    const stale = results.find((r) => !this.isFresh(r));
    if (stale !== undefined) {
      return {
        gate: 'STALE',
        outcome: this.#outcome(
          evidence,
          'blocked',
          'blocked',
          'required_user_action',
          're-run stale validation',
        ),
      };
    }
    for (const r of results) {
      if (r.mandatory && r.status !== 'PASSED') {
        return {
          gate: 'UNSATISFIED',
          outcome: this.#outcome(
            evidence,
            'failed',
            `${r.validatorId} not passed`,
            r.status === 'FAILED' ? 'required_user_action' : 'safe',
            'fix failed validation',
          ),
        };
      }
    }
    for (const artifactId of evidence.requiredArtifactIds) {
      const scan = evidence.artifactScanStates[artifactId];
      if (scan !== 'SAFE') {
        return {
          gate: 'UNSATISFIED',
          outcome: this.#outcome(
            evidence,
            'failed',
            `artifact ${artifactId} not safe`,
            'required_user_action',
            'quarantine/replace artifact',
          ),
        };
      }
    }
    if (evidence.notCompletedItems.length > 0) {
        return { gate: 'UNSATISFIED', outcome: this.#outcome(evidence, 'partial', 'workflow items remain incomplete', 'required_user_action', 'complete remaining items') };
      }
      if (evidence.prPendingApproval) {
      return {
        gate: 'UNSATISFIED',
        outcome: this.#outcome(
          evidence,
          'partial',
          'awaiting PR approval',
          'required_user_action',
          'await approval',
        ),
      };
    }
    return {
      gate: 'SATISFIED',
      outcome: this.#outcome(
        evidence,
        'success',
        'all validations passed and artifacts safe',
        'none',
        'complete',
      ),
    };
  }

  #outcome(
    evidence: OutcomeEvidenceInput,
    kind: WorkflowOutcomeKind,
    summary: string,
    retryability: WorkflowOutcome['retryability'],
    nextAction: string,
  ): WorkflowOutcome {
    return { runId: evidence.runId, kind, summary, retryability, nextAction };
  }
}

export interface OutcomeCommitStorePort {
  commit(outcome: WorkflowOutcome): Promise<void>;
}

export class InMemoryOutcomeStore implements OutcomeCommitStorePort {
  readonly outcomes = new Map<string, WorkflowOutcome>();
  async commit(outcome: WorkflowOutcome): Promise<void> {
    this.outcomes.set(outcome.runId, outcome);
  }
  async get(runId: string): Promise<WorkflowOutcome | undefined> {
    return this.outcomes.get(runId);
  }
}

export const validationContractsSchema = { workflowOutcomeKindSchema };

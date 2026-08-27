/**
 * C030 §8/§10/§13 — persisted decision records and the service that binds
 * evaluation to durable storage before any dispatch can occur.
 *
 * Persistence contract: insert attempt + decision + outbox event in ONE
 * transaction through the port. Executors accept only an AuthorizedActionToken
 * whose decision fingerprint still verifies (verifyDispatch).
 */
import { createHash } from 'node:crypto';
import type { Obligation } from '@devguard/contracts';
import {
  EVALUATOR_VERSION,
  evaluatePrecedence,
  mergeSnapshotWithCurrent,
  type DecisionEffect,
  type EvaluationInput,
  type EvaluationOutcome,
  type MatchedRule,
  type RiskClass5,
} from './precedence.js';
export type { DecisionEffect, EvaluationInput, EvaluationOutcome, MatchedRule, RiskClass5 };

export interface PolicyDecisionRecord {
  readonly id: string;
  readonly workflowRunId: string;
  readonly actionOperationKey: string;
  readonly effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  readonly reasonCode: string;
  readonly obligations: readonly Obligation[];
  readonly matchedRules: ReadonlyArray<{
    stage: number;
    ruleId: string;
    effect: string;
    explanation: string;
  }>;
  readonly explanation: string;
  readonly inputFingerprint: string;
  readonly policySnapshotId: string;
  readonly currentPolicyVersionId: string;
  readonly globalSafetyVersionId: string;
  readonly registrySnapshotId: string;
  readonly evaluatorVersion: string;
  readonly createdAtIso: string;
}

/** Port implemented by persistence; single-transaction semantics expected. */
export interface DecisionPersistencePort {
  persistAttemptAndDecision(params: {
    decision: PolicyDecisionRecord;
    outboxEvent: { eventType: string; payload: Record<string, unknown> };
  }): Promise<{ persisted: true }>;
}

export interface EvaluationRequest extends EvaluationInput {
  readonly repositoryId: string;
  readonly workflowRunId: string;
  readonly actionOperationKey: string;
  readonly policySnapshotId: string;
  readonly currentPolicyVersionId: string;
  readonly globalSafetyVersionId: string;
  readonly registrySnapshotId: string;
}

export class DecisionStoreUnavailableError extends Error {}

export function inputFingerprint(request: EvaluationRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.actionId,
        request.riskClass,
        request.repositoryDenyMatch,
        request.globalDenyMatch,
        request.globalApprovalFloorMatch,
        request.workflowPermitted,
        request.ceilingEffect,
        request.contextRequiresApproval,
        request.sandboxRequired,
        request.gateRequired,
        request.gateSatisfied,
        request.explicitAllowMatch,
        request.explicitRequireApprovalMatch,
        request.explicitDenyMatch,
        request.exactValidApprovalPresent,
        request.targetsProtectedBranch ?? false,
        request.mergesProtectedBranch ?? false,
      ]),
    )
    .digest('hex');
}

/**
 * Issue a dispatch token bound to a committed ALLOW decision. The token is an
 * opaque server-side reference (C030 §28 MVP decision): revocable, never
 * user/model-authored.
 */
export interface AuthorizedActionToken {
  readonly decisionId: string;
  readonly tokenHash: string;
  readonly operationFingerprint: string;
  readonly expiresAtMs: number;
}

export class PolicyEvaluationService {
  constructor(
    private readonly persistence: DecisionPersistencePort,
    private readonly newId: () => string,
  ) {}

  /** Pure evaluation exposed for replay/preview — persists nothing. */
  evaluate(
    request: EvaluationRequest,
    nowIso: string,
  ): PolicyDecisionRecord & { outcomeHash: string } {
    const fp = inputFingerprint(request);
    const outcome: EvaluationOutcome = evaluatePrecedence(request);
    const record: PolicyDecisionRecord = Object.freeze({
      id: this.newId(),
      workflowRunId: request.workflowRunId,
      actionOperationKey: request.actionOperationKey,
      effect: outcome.effect,
      reasonCode: outcome.reasonCode,
      obligations: outcome.obligations,
      matchedRules: outcome.matchedRules,
      explanation: outcome.explanation,
      inputFingerprint: fp,
      policySnapshotId: request.policySnapshotId,
      currentPolicyVersionId: request.currentPolicyVersionId,
      globalSafetyVersionId: request.globalSafetyVersionId,
      registrySnapshotId: request.registrySnapshotId,
      evaluatorVersion: EVALUATOR_VERSION,
      createdAtIso: nowIso,
    });
    return Object.freeze({ ...record, outcomeHash: decisionHash(record) });
  }

  /**
   * Evaluate AND durably persist in one transaction BEFORE returning. If the
   * persistence port fails, nothing has been dispatched and the error
   * propagates (fail closed) — no half-persisted decisions exist.
   */
  async evaluateAndPersist(
    request: EvaluationRequest,
    context: { nowMs?: number | undefined } = {},
  ): Promise<PolicyDecisionRecord & { outcomeHash: string }> {
    const nowIso = new Date(context.nowMs ?? Date.now()).toISOString();
    const record = this.evaluate(request, nowIso);
    try {
      await this.persistence.persistAttemptAndDecision({
        decision: record,
        outboxEvent: {
          eventType:
            record.effect === 'ALLOW'
              ? 'action.authorized'
              : record.effect === 'REQUIRE_APPROVAL'
                ? 'approval.required'
                : 'action.denied',
          payload: {
            decisionId: record.id,
            workflowRunId: record.workflowRunId,
            actionOperationKey: record.actionOperationKey,
            effect: record.effect,
            reasonCode: record.reasonCode,
          },
        },
      });
    } catch (error) {
      throw new DecisionStoreUnavailableError(
        `decision persistence failed; no action may be dispatched (${String((error as Error)?.message ?? error)})`,
      );
    }
    return record;
  }

  /**
   * Pre-dispatch verification: re-checks the fingerprint of the CURRENT
   * context against the committed decision's binding. Any mismatch blocks
   * dispatch and marks the attempt stale (C030 §9).
   */
  verifyDispatch(
    token: AuthorizedActionToken,
    current: { inputFingerprint: string; nowMs: number },
  ): { allowed: boolean; reasonCode?: string | undefined } {
    if (current.nowMs >= token.expiresAtMs) {
      return { allowed: false, reasonCode: 'DECISION_STALE' };
    }
    if (token.operationFingerprint !== current.inputFingerprint) {
      return { allowed: false, reasonCode: 'CONTEXT_CHANGED' };
    }
    return { allowed: true };
  }

  static issueToken(
    record: PolicyDecisionRecord,
    ttlMs: number,
    nowMs: number,
  ): AuthorizedActionToken {
    if (record.effect !== 'ALLOW') {
      throw new Error('cannot issue a dispatch token for a non-ALLOW decision');
    }
    const tokenHash = createHash('sha256')
      .update([record.id, record.inputFingerprint, nowMs + ttlMs].join('|'))
      .digest('hex');
    return Object.freeze({
      decisionId: record.id,
      tokenHash,
      operationFingerprint: record.inputFingerprint,
      expiresAtMs: nowMs + ttlMs,
    });
  }
}

function decisionHash(record: PolicyDecisionRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export { mergeSnapshotWithCurrent, evaluatePrecedence, EVALUATOR_VERSION };

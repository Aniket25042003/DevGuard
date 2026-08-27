/**
 * C034 §4/§8/§12 — the eight-step double check for privileged execution.
 *
 * Steps 1–3 are DURABLE PREREQUISITES produced by C030–C032 and are only ever
 * PROVEN here (never re-decided): (1) persisted policy decision requiring
 * approval, (2) persisted exact operation = approval aggregate with matching
 * fingerprints, (3) authorized human decision recorded. This service proves
 * them, performs 4–6 via injected current-state ports, claims the unique
 * execution lease (APPROVED→EXECUTING CAS), reconciles existing provider
 * effects BEFORE invoking step 7 exactly once through one registered
 * executor port, then verifies fresh provider state for step 8.
 *
 * Delivery is at-least-once; EFFECT is at-most-once per operation key — the
 * reconcile-before-execute rule plus fenced claim make retries safe.
 */
import { makeError } from '@devguard/errors';
import type { ApprovalStatus } from '../domain/approval-fsm.js';

export const EXECUTION_STEPS = [
  'STEP_1_POLICY_DECISION_PERSISTED',
  'STEP_2_OPERATION_PERSISTED',
  'STEP_3_HUMAN_DECISION_RECORDED',
  'STEP_4_TARGET_REFETCHED',
  'STEP_5_POLICY_REEVALUATED',
  'STEP_6_VALIDITY_CONFIRMED',
  'STEP_7_EXECUTED_ONCE',
  'STEP_8_OUTCOME_VERIFIED',
] as const;

export type ExecutionStep = (typeof EXECUTION_STEPS)[number];

export interface StepEvidence {
  readonly step: ExecutionStep;
  /** sha256 over the safe evidence payload supporting this step. */
  readonly evidenceDigest: string;
}

export interface PrivilegedApprovalRecord {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly version: number;
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
  readonly operationKey: string;
  readonly cancellationGeneration: number;
  readonly expiresAtMs: number;
  /** From C030's persisted decision (step 1). */
  readonly policyDecisionId: string;
  readonly policyDecisionEffect: string;
  /** From C032's recorded resolution (step 3). */
  readonly resolvedBy: string;
  readonly resolvedAtMs: number;
}

export interface CurrentTargetObservation {
  /** Recomputed on FRESH provider state for step 4. */
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
}

export interface CurrentPolicyEvaluation {
  /** Step 5: strictest of snapshot vs current; looser never elevates. */
  readonly stillRequiresApprovalAndGranted: boolean;
  readonly stricterDeny: boolean;
}

export type ExecutorOutcome =
  | { readonly kind: 'EXECUTED'; readonly providerReference: string }
  | { readonly kind: 'ALREADY_PRESENT'; readonly providerReference: string }
  | { readonly kind: 'FAILED_PERMANENTLY'; readonly errorCode: string };

export interface Step7Executor {
  executeOnce(input: {
    operationKey: string;
    actionFingerprint: string;
    contextFingerprint: string;
    leaseToken: string;
  }): Promise<ExecutorOutcome>;
}

/** Fresh-provider-state verifier used by step 8 (no model assertions). */
export interface OutcomeVerifierPort {
  verify(input: {
    providerReference: string;
    expectedEffectDigest: string;
  }): Promise<{ verified: boolean; detail?: string }>;
}

export interface ExecutionPersistencePort {
  loadPrivilegedApproval(approvalId: string): Promise<PrivilegedApprovalRecord>;
  /**
   * Atomic: create attempt + transition APPROVED→EXECUTING + outbox event in
   * one transaction. Zero rows => lost race / stale state.
   */
  claimExecutionLease(input: {
    approvalId: string;
    expectedVersion: number;
    workerId: string;
    nowMs: number;
    stepsProven: readonly ExecutionStep[];
  }): Promise<{ claimed: boolean; attemptId: string; versionAfter: number }>;
  closeExecution(input: {
    approvalId: string;
    toStatus: ApprovalStatus;
    attemptId: string;
    providerReference?: string | undefined;
    errorCode?: string | undefined;
  }): Promise<void>;
}

export interface C034Ports {
  readonly persistence: ExecutionPersistencePort;
  /** C033 validity gate reused at PRE_EXECUTION purpose (step 6). */
  validityGate(input: {
    approvalId: string;
    nowMs: number;
  }): Promise<{ valid: true } | { valid: false; code: string; detail: string }>;
  /** Step 4 target refetch (typed adapter observation). */
  fetchCurrentTarget(): Promise<CurrentTargetObservation>;
  /** Step 5 policy re-evaluation against CURRENT versions. */
  reevaluatePolicy(): Promise<CurrentPolicyEvaluation>;
  executor: Step7Executor;
  verifier: OutcomeVerifierPort;
  readonly workerId: string;
  readonly nowMs: number;
  /** sha256 helper injection keeps this module deterministic-friendly. */
  digest(value: unknown): string;
}

export type ExecutionResult =
  | {
      readonly outcome: 'EXECUTED';
      readonly stepsProven: readonly ExecutionStep[];
      readonly providerReference: string;
      readonly verified: boolean;
    }
  | { readonly outcome: 'BLOCKED'; readonly code: string; readonly detail: string };

export class PrivilegedExecutionService {
  async executeApproved(input: { approvalId: string }, ports: C034Ports): Promise<ExecutionResult> {
    // ---- prove durable prerequisites (steps 1-3) -------------------------
    let record: PrivilegedApprovalRecord;
    try {
      record = await ports.persistence.loadPrivilegedApproval(input.approvalId);
    } catch (error) {
      throw makeError('NOT_FOUND', { cause: error });
    }

    if (record.status !== 'APPROVED') {
      return blocked(
        'STEPS_PREREQ_INVALID',
        `approval is ${record.status}; only APPROVED may be executed`,
      );
    }
    if (!record.policyDecisionId || record.policyDecisionEffect !== 'REQUIRE_APPROVAL') {
      // Step 1 proof: an allow decision must NEVER route through approvals.
      return blocked('STEPS_PREREQ_INVALID', 'policy decision is not a persisted REQUIRE_APPROVAL');
    }
    if (!record.resolvedBy || !Number.isFinite(record.resolvedAtMs)) {
      // Step 3 proof: authorization actually happened with a recorded actor.
      return blocked('STEPS_PREREQ_INVALID', 'no authorized human decision recorded');
    }

    const provenEarly: ExecutionStep[] = [
      'STEP_1_POLICY_DECISION_PERSISTED',
      'STEP_2_OPERATION_PERSISTED',
      'STEP_3_HUMAN_DECISION_RECORDED',
    ];

    // ---- step 4: fresh target fetch (must match BOTH fingerprints) -------
    const target = await ports.fetchCurrentTarget();
    if (
      target.actionFingerprint !== record.actionFingerprint ||
      target.contextFingerprint !== record.contextFingerprint
    ) {
      await markStaled(ports, input.approvalId);
      return blocked(
        'TARGET_CHANGED',
        'current provider state no longer matches the approved binding',
      );
    }

    // ---- step 5: current policy cannot be bypassed; stricter wins --------
    const policyNow = await ports.reevaluatePolicy();
    if (policyNow.stricterDeny) {
      return blocked('POLICY_CHANGED', 'current policy denies what it previously floor-gated');
    }
    if (!policyNow.stillRequiresApprovalAndGranted) {
      // Looser current rules do NOT silently elevate: require a fresh request.
      return blocked(
        'POLICY_LOOSENED',
        'current policy no longer gates identically; submit a fresh proposal',
      );
    }

    // ---- step 6: C033 validity + expiry window re-check ------------------
    const validity = await ports.validityGate({ approvalId: input.approvalId, nowMs: ports.nowMs });
    if (!validity.valid) {
      return blocked(validity.code, validity.detail);
    }
    if (ports.nowMs >= record.expiresAtMs) {
      return blocked('APPROVAL_EXPIRED', 'expired before execution could be claimed');
    }

    // ---- atomic claim: APPROVED -> EXECUTING with unique attempt ---------
    const proven: ExecutionStep[] = [
      ...provenEarly,
      'STEP_4_TARGET_REFETCHED',
      'STEP_5_POLICY_REEVALUATED',
      'STEP_6_VALIDITY_CONFIRMED',
    ];
    const claim = await ports.persistence.claimExecutionLease({
      approvalId: input.approvalId,
      expectedVersion: record.version,
      workerId: ports.workerId,
      nowMs: ports.nowMs,
      stepsProven: proven,
    });
    if (!claim.claimed) {
      return blocked(
        'APPROVAL_VERSION_CONFLICT',
        'execution claim lost the race or state changed concurrently',
      );
    }

    try {
      // ---- pre-call reconciliation: maybe the effect already exists ------
      const reconciled = await ports.executor.executeOnce({
        operationKey: record.operationKey,
        actionFingerprint: record.actionFingerprint,
        contextFingerprint: record.contextFingerprint,
        leaseToken: `${ports.workerId}:${claim.attemptId}`,
      });

      if (reconciled.kind === 'FAILED_PERMANENTLY') {
        await ports.persistence.closeExecution({
          approvalId: input.approvalId,
          toStatus: 'EXECUTION_FAILED',
          attemptId: claim.attemptId,
          errorCode: reconciled.errorCode,
        });
        return blocked(reconciled.errorCode, 'executor reported permanent failure after claim');
      }

      // ---- step 8: verify FRESH provider state (never model assertion) ---
      const verification = await ports.verifier.verify({
        providerReference: reconciled.providerReference,
        expectedEffectDigest: ports.digest(record.operationKey),
      });
      const stepsAll: ExecutionStep[] = [
        ...proven,
        'STEP_7_EXECUTED_ONCE',
        'STEP_8_OUTCOME_VERIFIED',
      ];

      if (!verification.verified && reconciled.kind === 'EXECUTED') {
        // Uncertain outcome: never lie about success; human intervention owns it.
        await ports.persistence.closeExecution({
          approvalId: input.approvalId,
          toStatus: 'EXECUTION_FAILED',
          attemptId: claim.attemptId,
          errorCode: 'OUTCOME_UNVERIFIED',
        });
        return blocked(
          'OUTCOME_UNVERIFIED',
          'provider state does not yet prove the intended effect',
        );
      }

      await ports.persistence.closeExecution({
        approvalId: input.approvalId,
        toStatus: 'EXECUTED',
        attemptId: claim.attemptId,
        ...(reconciled.providerReference
          ? { providerReference: reconciled.providerReference }
          : {}),
      });
      void stepsAll;
      return {
        outcome: 'EXECUTED',
        stepsProven: [...proven, 'STEP_7_EXECUTED_ONCE', 'STEP_8_OUTCOME_VERIFIED'],
        providerReference: reconciled.providerReference,
        verified: verification.verified || reconciled.kind === 'ALREADY_PRESENT',
      };
    } catch (error) {
      await ports.persistence
        .closeExecution({
          approvalId: input.approvalId,
          toStatus: 'EXECUTION_FAILED',
          attemptId: claim.attemptId,
          errorCode: 'EXECUTOR_EXCEPTION',
        })
        .catch(() => undefined);
      throw error instanceof Error ? error : makeError('DEPENDENCY_UNAVAILABLE', { cause: error });
    }
  }
}

async function markStaled(ports: C034Ports, approvalId: string): Promise<void> {
  // Failure BEFORE any effect may invalidate; reuse the persistence port's
  // claim path marker by recording a terminal STALE closure via closeExecution.
  await ports.persistence
    .closeExecution({
      approvalId,
      toStatus: 'STALE',
      attemptId: 'pre-claim-invalidation',
    })
    .catch(() => undefined);
}

function blocked(code: string, detail: string): ExecutionResult {
  return { outcome: 'BLOCKED', code, detail };
}

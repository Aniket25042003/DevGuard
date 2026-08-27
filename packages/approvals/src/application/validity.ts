/**
 * C033 §8/§9/§10 — validity checks: STALE vs EXPIRED vs VALID determinations.
 *
 * - → EXPIRED iff database now >= expiresAt (TIME_EXPIRED never maps to stale).
 * - → STALE iff any current canonical field differs from the binding,
 *   required validation is not fresh/passing, workflow generation superseded,
 *   or fingerprint schema cannot be safely recomputed.
 * - Validity checks are append-only EVIDENCE (checkId-returned) and use CAS
 *   against expected approval version/status when they transition state.
 */
import { makeError } from '@devguard/errors';
import { resolveEdge, type ApprovalStatus } from '../domain/approval-fsm.js';

export const STALE_REASON_CODES = [
  'ACTION_CHANGED',
  'TARGET_CHANGED',
  'PR_HEAD_CHANGED',
  'PR_BASE_CHANGED',
  'PR_STATE_CHANGED',
  'BRANCH_SHA_CHANGED',
  'DEFAULT_BRANCH_CHANGED',
  'POLICY_CHANGED',
  'RISK_CHANGED',
  'VALIDATION_CHANGED',
  'VALIDATION_EXPIRED',
  'REPOSITORY_CHANGED',
  'WORKFLOW_SUPERSEDED',
  'FINGERPRINT_SCHEMA_UNSUPPORTED',
] as const;

export type StaleReasonCode = (typeof STALE_REASON_CODES)[number];

export type ValidityPurpose = 'RESOLUTION' | 'EVENT' | 'SCHEDULED' | 'PRE_EXECUTION' | 'RECOVERY';

export interface CurrentBindingObservation {
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
  /** Workflow cancellation generation as observed NOW. */
  readonly currentCancellationGeneration: number;
  /** Trusted typed hints describing the changed canonical context fields. */
  readonly contextChangeReasons?: readonly StaleReasonCode[];
}

export interface ExpiringApprovalState {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly version: number;
  readonly expiresAtMs: number;
  readonly boundActionFingerprint: string;
  readonly boundContextFingerprint: string;
  readonly boundCancellationGeneration: number;
  readonly supportedFingerprintSchemaVersion: boolean;
}

/** Append-only validity evidence record (C033 §8). */
export interface ValidityCheckRecord {
  readonly checkId: string;
  readonly kind: ValidityPurpose;
  readonly result: 'VALID' | 'STALE' | 'EXPIRED';
  readonly reasonCodes: readonly StaleReasonCode[];
  readonly boundContextFingerprint: string;
  readonly currentContextFingerprint: string;
  readonly checkedAtMs: number;
}

export interface ValidityPersistencePort {
  loadExpiringApproval(approvalId: string): Promise<ExpiringApprovalState>;
  appendValidityCheck(record: ValidityCheckRecord & { readonly approvalId: string }): Promise<void>;
  /** CAS EXPIRE/STALE using expected version+status; zero rows => lost race. */
  compareAndSet(input: {
    approvalId: string;
    expectedVersion: number;
    from: ApprovalStatus;
    to: ApprovalStatus;
    commandKey: string;
    reasonCodes: readonly string[];
  }): Promise<{ applied: boolean; versionAfter: number }>;
}

export class ApprovalValidityService {
  constructor(
    private readonly persistence: ValidityPersistencePort,
    private readonly newCheckId: () => string,
  ) {}

  /**
   * Pure determination for fixed inputs. Expiry uses ONLY the supplied
   * database-clock reading.
   */
  determine(
    state: ExpiringApprovalState,
    current: CurrentBindingObservation,
    nowMs: number,
    _purpose?: ValidityPurpose | undefined,
  ): { result: 'VALID' | 'STALE' | 'EXPIRED'; reasonCodes: readonly StaleReasonCode[] } {
    if (nowMs >= state.expiresAtMs) {
      return { result: 'EXPIRED', reasonCodes: [] };
    }
    const reasons: StaleReasonCode[] = [];
    if (!state.supportedFingerprintSchemaVersion) {
      reasons.push('FINGERPRINT_SCHEMA_UNSUPPORTED');
    }
    if (current.actionFingerprint !== state.boundActionFingerprint) {
      reasons.push('ACTION_CHANGED');
    }
    if (current.contextFingerprint !== state.boundContextFingerprint) {
      reasons.push(...this.contextStalenessReasons(current));
      void current.contextFingerprint; // diff detail is caller-supplied via digests
    }
    if (current.currentCancellationGeneration > state.boundCancellationGeneration) {
      reasons.push('WORKFLOW_SUPERSEDED');
    }
    return { result: reasons.length > 0 ? 'STALE' : 'VALID', reasonCodes: [...new Set(reasons)] };
  }

  /** Context-diff mapping helper; concrete diffs arrive as explicit hints. */
  private contextStalenessReasons(current: CurrentBindingObservation): StaleReasonCode[] {
    // Field-level reasons are supplied by the trusted observation builder; a
    // digest alone cannot identify which canonical field changed.
    return current.contextChangeReasons?.length
      ? [...new Set(current.contextChangeReasons)]
      : ['TARGET_CHANGED'];
  }

  async check(input: {
    approvalId: string;
    purpose: ValidityPurpose;
    current: CurrentBindingObservation;
    nowMs: number;
  }): Promise<
    | {
        kind: 'VALID';
        approvalVersion: number;
        contextFingerprint: string;
        validThroughMs: number;
        checkId: string;
      }
    | { kind: 'STALE'; reasonCodes: readonly StaleReasonCode[]; checkId: string; applied: boolean }
    | { kind: 'EXPIRED'; checkId: string; applied: boolean }
    | { kind: 'INDETERMINATE_FAIL_CLOSED'; code: string; checkId?: undefined }
  > {
    const state = await this.persistence.loadExpiringApproval(input.approvalId);
    if (state.status === 'EXECUTING') {
      // C033 cannot touch EXECUTING on webhook/schedule purposes; C034 owns
      // the fenced attempt. Read-only evidence only.
      if (input.purpose === 'PRE_EXECUTION' || input.purpose === 'RECOVERY') {
        // allowed below; treat like others but transitions remain C034's duty
      } else {
        const checkId = this.newCheckId();
        await this.persistence.appendValidityCheck({
          checkId,
          approvalId: input.approvalId,
          kind: input.purpose,
          result: 'VALID',
          reasonCodes: [],
          boundContextFingerprint: state.boundContextFingerprint,
          currentContextFingerprint: input.current.contextFingerprint,
          checkedAtMs: input.nowMs,
        });
        return {
          kind: 'VALID',
          approvalVersion: state.version,
          contextFingerprint: state.boundContextFingerprint,
          validThroughMs: state.expiresAtMs,
          checkId,
        };
      }
    }
    if (
      ['REJECTED', 'EXPIRED', 'CANCELLED', 'STALE', 'EXECUTED', 'EXECUTION_FAILED'].includes(
        state.status,
      )
    ) {
      return { kind: 'INDETERMINATE_FAIL_CLOSED', code: `APPROVAL_TERMINAL_${state.status}` };
    }

    const determined = this.determine(state, input.current, input.nowMs, input.purpose);
    const checkId = this.newCheckId();
    await this.persistence.appendValidityCheck({
      checkId,
      approvalId: input.approvalId,
      kind: input.purpose,
      result: determined.result,
      reasonCodes: determined.reasonCodes,
      boundContextFingerprint: state.boundContextFingerprint,
      currentContextFingerprint: input.current.contextFingerprint,
      checkedAtMs: input.nowMs,
    });

    if (determined.result === 'VALID') {
      return {
        kind: 'VALID',
        approvalVersion: state.version,
        contextFingerprint: state.boundContextFingerprint,
        validThroughMs: state.expiresAtMs,
        checkId,
      };
    }

    if (state.status === 'EXECUTING' && (input.purpose === 'PRE_EXECUTION' || input.purpose === 'RECOVERY')) {
        if (determined.result === 'STALE') return { kind: 'STALE', reasonCodes: determined.reasonCodes, checkId, applied: false };
        if (determined.result === 'EXPIRED') return { kind: 'EXPIRED', checkId, applied: false };
      }

      if (determined.result === 'EXPIRED') {
      const applied = await this.persistence.compareAndSet({
        approvalId: input.approvalId,
        expectedVersion: state.version,
        from: state.status,
        to: 'EXPIRED',
        commandKey: `expire:${input.purpose}:${checkId}`,
        reasonCodes: ['TIME_EXPIRED'],
      });
      return { kind: 'EXPIRED', checkId, applied: applied.applied };
    }

    const verdict = resolveEdge(state.status, 'mark-stale', { contextMatchesBinding: false });
    if (!verdict.allowed) {
      throw makeError('APPROVAL_ILLEGAL_TRANSITION');
    }
    const applied = await this.persistence.compareAndSet({
      approvalId: input.approvalId,
      expectedVersion: state.version,
      from: state.status,
      to: 'STALE',
      commandKey: `stale:${input.purpose}:${checkId}`,
      reasonCodes: determined.reasonCodes,
    });
    return {
      kind: 'STALE',
      reasonCodes: determined.reasonCodes,
      checkId,
      applied: applied.applied,
    };
  }

  /**
   * Deduped expiry scan: claim up to `limit` PENDING/APPROVED approvals whose
   * expiresAt has passed and expire them CAS-fully. Returns count expired.
   */
  async expireDue(input: {
    candidates: ReadonlyArray<
      Pick<ExpiringApprovalState, 'id' | 'status' | 'version' | 'expiresAtMs'>
    >;
    nowMs: number;
  }): Promise<number> {
    let expiredCount = 0;
    for (const candidate of input.candidates) {
      if (candidate.status !== 'PENDING' && candidate.status !== 'APPROVED') continue;
      if (input.nowMs < candidate.expiresAtMs) continue;
      const applied = await this.persistence.compareAndSet({
        approvalId: candidate.id,
        expectedVersion: candidate.version,
        from: candidate.status,
        to: 'EXPIRED',
        commandKey: `expire:scheduled:${candidate.id}:${candidate.version}`,
        reasonCodes: ['TIME_EXPIRED'],
      });
      if (applied.applied) expiredCount += 1;
    }
    return expiredCount;
  }
}

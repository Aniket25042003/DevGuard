/**
 * C029 §10/§12/§22 — ValidationGateService: obligation resolution, evidence
 * evaluation and staleness detection with an injected clock.
 *
 * All-of semantics: every applicable obligation must present EXACT-target,
 * fresh, verified PASSED evidence. Anything else blocks (or is UNKNOWN when
 * the failure itself is unknowable, e.g. forged/unregistered provenance).
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_OBLIGATIONS,
  mergeObligations,
  type GateKind,
  type ValidationEvidence,
  type ValidationObligation,
} from './schemas.js';

export interface GateContext {
  readonly gateKind: GateKind;
  readonly policySnapshotId: string;
  readonly currentPolicyVersionId: string;
  readonly validatorRegistryVersion: string;
  /** Canonical target binding (repo|ref|sha|diffhash). */
  readonly targetFingerprint: string;
  readonly repositoryId: string;
  /** Repository/workflow-added obligations; cannot remove global ones. */
  readonly extraObligations?: readonly ValidationObligation[] | undefined;
}

export interface ObligationAssessment {
  readonly validatorId: string;
  readonly sourceRuleId: string;
  readonly verdict:
    | 'PASSED'
    | 'FAILED'
    | 'SKIPPED'
    | 'CANCELLED'
    | 'TIMED_OUT'
    | 'MISSING'
    | 'STALE_AGE'
    | 'WRONG_TARGET'
    | 'UNKNOWN_PROVENANCE';
  readonly explanation: string;
  readonly selectedEvidenceResultKey?: string | undefined;
}

export interface GateOutcome {
  readonly status: 'SATISFIED' | 'BLOCKED' | 'UNKNOWN';
  readonly assessments: readonly ObligationAssessment[];
  readonly targetFingerprint: string;
  readonly evaluatedAtMs: number;
  readonly policySnapshotId: string;
  readonly currentPolicyVersionId: string;
  readonly validatorRegistryVersion: string;
  readonly outcomeHash: string;
}

const TRUSTED_PROVENANCE = new Set(['github_checks', 'sandbox_validator', 'devguard_service']);

export class ValidationGateService {
  constructor(
    private readonly globalObligations: readonly ValidationObligation[] = DEFAULT_OBLIGATIONS,
  ) {}

  resolveObligations(context: GateContext): readonly ValidationObligation[] {
    const applicableGlobal = this.globalObligations.filter((obligation) =>
      obligation.applicableGates.includes(context.gateKind),
    );
    // Repository/workflow obligations can only ADD or TIGHTEN.
    const extras = (context.extraObligations ?? []).filter((obligation) =>
      obligation.applicableGates.includes(context.gateKind),
    );
    return mergeObligations([applicableGlobal, extras]);
  }

  evaluate(
    context: GateContext,
    evidence: readonly ValidationEvidence[],
    nowMs: number,
  ): GateOutcome {
    const assessments: ObligationAssessment[] = [];
    let unknown = false;

    for (const obligation of this.resolveObligations(context)) {
      assessments.push(this.#assess(context, obligation, evidence, nowMs));
    }
    if (assessments.some((assessment) => assessment.verdict === 'UNKNOWN_PROVENANCE'))
      unknown = true;

    const blocked = assessments.some((assessment) => assessment.verdict !== 'PASSED');

    const outcome: GateOutcome = Object.freeze({
      status: unknown ? 'UNKNOWN' : blocked ? 'BLOCKED' : 'SATISFIED',
      assessments,
      targetFingerprint: context.targetFingerprint,
      evaluatedAtMs: nowMs,
      policySnapshotId: context.policySnapshotId,
      currentPolicyVersionId: context.currentPolicyVersionId,
      validatorRegistryVersion: context.validatorRegistryVersion,
      outcomeHash: '',
    });
    return Object.freeze({
      ...outcome,
      outcomeHash: createHash('sha256')
        .update(
          JSON.stringify([
            context.gateKind,
            context.policySnapshotId,
            context.currentPolicyVersionId,
            context.validatorRegistryVersion,
            context.targetFingerprint,
            assessments.map((a) => [
              a.validatorId,
              a.sourceRuleId,
              a.verdict,
              a.selectedEvidenceResultKey,
            ]),
            nowMs,
          ]),
        )
        .digest('hex'),
    });
  }

  #assess(
    context: GateContext,
    obligation: ValidationObligation,
    evidence: readonly ValidationEvidence[],
    nowMs: number,
  ): ObligationAssessment {
    // Deterministic supersession: newest matching evidence by producedAt, then
    // resultKey for total ordering.
    const candidates = evidence
      .filter((item) => item.validatorId === obligation.validatorId)
      .sort((a, b) => b.producedAtMs - a.producedAtMs || a.resultKey.localeCompare(b.resultKey));

    if (candidates.length === 0) {
      return {
        validatorId: obligation.validatorId,
        sourceRuleId: obligation.sourceRuleId,
        verdict: 'MISSING',
        explanation: `no evidence for required validator '${obligation.validatorId}'`,
      };
    }
    // Latest valid record wins but ALL conflicting records stay in the audit
    // surface via result keys on the caller side (C029 §18 conflicts).
    for (const candidate of candidates) {
      if (!TRUSTED_PROVENANCE.has(candidate.provenance)) {
        return {
          validatorId: obligation.validatorId,
          sourceRuleId: obligation.sourceRuleId,
          verdict: 'UNKNOWN_PROVENANCE',
          explanation: `evidence '${candidate.resultKey}' carries untrusted provenance '${candidate.provenance}'`,
        };
      }
      if (
        obligation.requireTargetFingerprint &&
        candidate.targetFingerprint !== context.targetFingerprint
      ) {
        continue; // try an older exact-binding result before declaring wrong-target
      }
      const ageSeconds = Math.floor((nowMs - candidate.producedAtMs) / 1000);
      // Clock-accurate rule from C029 §22: AT or over max is stale.
      if (ageSeconds >= obligation.maxAgeSeconds) {
        return {
          validatorId: obligation.validatorId,
          sourceRuleId: obligation.sourceRuleId,
          verdict: 'STALE_AGE',
          explanation: `newest exact-target result ${candidate.resultKey} is ${ageSeconds}s old (max ${obligation.maxAgeSeconds}s); at/over max is stale`,
          selectedEvidenceResultKey: candidate.resultKey,
        };
      }
      if (candidate.status === 'PASSED') {
        return {
          validatorId: obligation.validatorId,
          sourceRuleId: obligation.sourceRuleId,
          verdict: 'PASSED',
          explanation: `exact-target passed evidence ${candidate.resultKey}`,
          selectedEvidenceResultKey: candidate.resultKey,
        };
      }
      return {
        validatorId: obligation.validatorId,
        sourceRuleId: obligation.sourceRuleId,
        verdict: candidate.status as ObligationAssessment['verdict'],
        explanation: `required evidence ${candidate.resultKey} was ${candidate.status}; only PASSED satisfies required obligations`,
        selectedEvidenceResultKey: candidate.resultKey,
      };
    }
    // Every candidate existed but none bound to this exact target.
    return {
      validatorId: obligation.validatorId,
      sourceRuleId: obligation.sourceRuleId,
      verdict: 'WRONG_TARGET',
      explanation: `${candidates.length} result(s) exist but none bind to target fingerprint ${context.targetFingerprint.slice(0, 12)}…`,
    };
  }

  /**
   * Staleness detection against the CURRENT context (C029 §9): any change of
   * fingerprint, policy version, registry version or obligation set stales
   * the prior outcome and forces re-evaluation.
   */
  isStale(
    outcome: Pick<
      GateOutcome,
      'targetFingerprint' | 'currentPolicyVersionId' | 'validatorRegistryVersion' | 'outcomeHash'
    >,
    current: GateContext,
    currentEvidence: readonly ValidationEvidence[],
    nowMs: number,
  ): { stale: boolean; causes: readonly string[] } {
    const causes: string[] = [];
    if (outcome.targetFingerprint !== current.targetFingerprint) causes.push('target changed');
    if (outcome.currentPolicyVersionId !== current.currentPolicyVersionId)
      causes.push('policy changed');
    if (outcome.validatorRegistryVersion !== current.validatorRegistryVersion)
      causes.push('validator registry changed');
    const expectedNow = this.evaluate(current, currentEvidence, nowMs);
    if (expectedNow.outcomeHash !== outcome.outcomeHash) causes.push('evaluation inputs changed');
    return { stale: causes.length > 0, causes };
  }
}

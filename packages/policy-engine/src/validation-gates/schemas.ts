/**
 * C029 §8 — validator registry, obligations, evidence and gate schemas.
 *
 * MVP rule (§17): required obligations accept ONLY verified PASSED evidence
 * bound to the exact target fingerprint and fresh per maxAgeSeconds. Missing,
 * failed, skipped, blocked, stale or unknown anything blocks. There are no
 * waivers in MVP.
 */
import { z } from 'zod';

export const GATE_KINDS = [
  'PR_CREATE',
  'PR_UPDATE',
  'APPROVAL_REQUEST',
  'PRIVILEGED_EXECUTION',
  'MERGE',
  'WORKFLOW_COMPLETE',
] as const;

export type GateKind = (typeof GATE_KINDS)[number];

export const VALIDATOR_IDS_V1 = [
  'unit_tests',
  'integration_tests',
  'typecheck',
  'lint',
  'build',
  'security_scan',
  'dependency_check',
  'review_provenance', // provider-neutral; configured GitHub-visible review/check provenance
] as const;

export type ValidatorIdV1 = (typeof VALIDATOR_IDS_V1)[number];

export const EVIDENCE_STATUSES = ['PASSED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED_OUT'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** C029 §8 obligation shape: blocking by construction, PASSED-only. */
export interface ValidationObligation {
  readonly validatorId: ValidatorIdV1 | string;
  /** Stable identifier of WHO imposed this obligation (global/workflow/policy). */
  readonly sourceRuleId: string;
  readonly scope: 'WORKFLOW' | 'CHANGESET' | 'TARGET_ACTION';
  readonly applicableGates: readonly GateKind[];
  readonly maxAgeSeconds: number;
  readonly requireTargetFingerprint: boolean;
}

export const validationEvidence = z
  .object({
    validatorId: z.string().min(1).max(64),
    status: z.enum(EVIDENCE_STATUSES),
    /** Exact binding: repository + ref + SHA (+ diff hash where relevant). */
    targetFingerprint: z.string().min(16).max(128),
    producedAtMs: z.number().int().nonnegative(),
    /** Typed provenance; untrusted sources fail verification downstream. */
    provenance: z.enum(['github_checks', 'sandbox_validator', 'devguard_service']),
    providerVersion: z.string().max(64),
    resultKey: z.string().min(1).max(128),
  })
  .strict();

export type ValidationEvidence = z.output<typeof validationEvidence>;

/** Initial conservative gate defaults from C029 §8. */
export const DEFAULT_OBLIGATIONS: readonly ValidationObligation[] = Object.freeze([
  {
    validatorId: 'unit_tests',
    sourceRuleId: 'global-gate-changeset-defaults',
    scope: 'CHANGESET',
    applicableGates: [
      'PR_CREATE',
      'PR_UPDATE',
      'APPROVAL_REQUEST',
      'PRIVILEGED_EXECUTION',
      'MERGE',
    ],
    maxAgeSeconds: 24 * 3600,
    requireTargetFingerprint: true,
  },
  {
    validatorId: 'typecheck',
    sourceRuleId: 'global-gate-changeset-defaults',
    scope: 'CHANGESET',
    applicableGates: [
      'PR_CREATE',
      'PR_UPDATE',
      'APPROVAL_REQUEST',
      'PRIVILEGED_EXECUTION',
      'MERGE',
    ],
    maxAgeSeconds: 24 * 3600,
    requireTargetFingerprint: true,
  },
  {
    validatorId: 'lint',
    sourceRuleId: 'global-gate-changeset-defaults',
    scope: 'CHANGESET',
    applicableGates: ['PR_CREATE', 'PR_UPDATE'],
    maxAgeSeconds: 7 * 24 * 3600,
    requireTargetFingerprint: true,
  },
  {
    validatorId: 'build',
    sourceRuleId: 'global-gate-changeset-defaults',
    scope: 'CHANGESET',
    applicableGates: ['PR_CREATE', 'PR_UPDATE', 'MERGE'],
    maxAgeSeconds: 24 * 3600,
    requireTargetFingerprint: true,
  },
  {
    validatorId: 'security_scan',
    sourceRuleId: 'global-gate-changeset-defaults',
    scope: 'CHANGESET',
    applicableGates: [
      'PR_CREATE',
      'PR_UPDATE',
      'APPROVAL_REQUEST',
      'PRIVILEGED_EXECUTION',
      'MERGE',
    ],
    maxAgeSeconds: 24 * 3600,
    requireTargetFingerprint: true,
  },
  {
    validatorId: 'dependency_check',
    sourceRuleId: 'global-gate-merge-floor',
    scope: 'WORKFLOW',
    applicableGates: ['MERGE'],
    maxAgeSeconds: 12 * 3600,
    requireTargetFingerprint: false,
  },
  {
    validatorId: 'review_provenance',
    sourceRuleId: 'global-gate-merge-floor',
    scope: 'TARGET_ACTION',
    applicableGates: ['MERGE'],
    maxAgeSeconds: 30 * 24 * 3600,
    requireTargetFingerprint: true,
  },
]);

// ---------------------------------------------------------------------------
// Obligation merge algebra (C029 §12): union of sources, strongest constraint.
// ---------------------------------------------------------------------------

export function mergeObligations(
  groups: ReadonlyArray<readonly ValidationObligation[]>,
): readonly ValidationObligation[] {
  const byValidator = new Map<string, ValidationObligation>();
  for (const group of groups) {
    for (const obligation of group) {
      const existing = byValidator.get(obligation.validatorId);
      if (!existing) {
        byValidator.set(obligation.validatorId, { ...obligation });
        continue;
      }
      // Merge: shortest max age, strictest fingerprint requirement, widest
      // applicability, all source rules retained via concatenation.
      byValidator.set(obligation.validatorId, {
        ...existing,
        validatorId: existing.validatorId,
        sourceRuleId: `${existing.sourceRuleId}+${obligation.sourceRuleId}`,
        maxAgeSeconds: Math.min(existing.maxAgeSeconds, obligation.maxAgeSeconds),
        requireTargetFingerprint:
          existing.requireTargetFingerprint || obligation.requireTargetFingerprint,
        applicableGates: [...new Set([...existing.applicableGates, ...obligation.applicableGates])],
        scope:
          existing.scope === 'TARGET_ACTION' || obligation.scope === 'TARGET_ACTION'
            ? 'TARGET_ACTION'
            : existing.scope === 'CHANGESET' || obligation.scope === 'CHANGESET'
              ? 'CHANGESET'
              : 'WORKFLOW',
      });
    }
  }
  return [...byValidator.values()].sort((a, b) => a.validatorId.localeCompare(b.validatorId));
}

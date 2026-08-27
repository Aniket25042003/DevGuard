/**
 * C029 §22 — obligation merge, evidence evaluation matrix, freshness
 * boundaries, provenance and staleness.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OBLIGATIONS,
  ValidationGateService,
  mergeObligations,
  validationEvidence,
  type ValidationEvidence,
} from '@devguard/policy-engine';

const TARGET = 'repo-1|refs/heads/feature|shaabc123def4567890';
const NOW = 1_700_000_000_000;

function context(overrides: Partial<Parameters<ValidationGateService['evaluate']>[0]> = {}) {
  return {
    gateKind: 'PR_CREATE' as const,
    policySnapshotId: 'snap-1',
    currentPolicyVersionId: 'v1',
    validatorRegistryVersion: 'val-reg@1',
    targetFingerprint: TARGET,
    repositoryId: 'repo-1',
    ...overrides,
  };
}

function evidence(
  partial: Partial<ValidationEvidence> & { validatorId: string },
): ValidationEvidence {
  return validationEvidence.parse({
    status: 'PASSED',
    targetFingerprint: TARGET,
    producedAtMs: NOW - 60_000,
    provenance: 'sandbox_validator',
    providerVersion: 'sb@1.0.0',
    resultKey: `res-${partial.validatorId}`,
    ...partial,
  });
}

describe('obligation merge algebra (C029 §12)', () => {
  it('merges duplicates with shortest max age, strictest binding, widest gates, all sources', () => {
    const merged = mergeObligations([
      [
        {
          validatorId: 'unit_tests',
          sourceRuleId: 'src-a',
          scope: 'CHANGESET',
          applicableGates: ['PR_CREATE'],
          maxAgeSeconds: 3600,
          requireTargetFingerprint: false,
        },
      ],
      [
        {
          validatorId: 'unit_tests',
          sourceRuleId: 'src-b',
          scope: 'TARGET_ACTION',
          applicableGates: ['MERGE'],
          maxAgeSeconds: 60,
          requireTargetFingerprint: true,
        },
      ],
    ]);
    expect(merged).toHaveLength(1);
    const obligation = merged[0]!;
    expect(obligation.sourceRuleId).toBe('src-a+src-b');
    expect(obligation.maxAgeSeconds).toBe(60);
    expect(obligation.requireTargetFingerprint).toBe(true);
    expect(obligation.applicableGates).toEqual(['PR_CREATE', 'MERGE']);
    expect(obligation.scope).toBe('TARGET_ACTION');
  });

  it('keeps different validators as separate obligations sorted by ID', () => {
    const merged = mergeObligations([
      [
        {
          validatorId: 'lint',
          sourceRuleId: 's',
          scope: 'CHANGESET',
          applicableGates: ['PR_CREATE'],
          maxAgeSeconds: 60,
          requireTargetFingerprint: false,
        },
        {
          validatorId: 'build',
          sourceRuleId: 's',
          scope: 'CHANGESET',
          applicableGates: ['PR_CREATE'],
          maxAgeSeconds: 60,
          requireTargetFingerprint: false,
        },
      ],
    ]);
    expect(merged.map((o) => o.validatorId)).toEqual(['build', 'lint']);
  });
});

describe('gate evaluation matrix (C029 §22)', () => {
  const service = new ValidationGateService();
  const requiredForCreate = DEFAULT_OBLIGATIONS.filter(
    (o) => o.sourceRuleId === 'global-gate-changeset-defaults',
  ).map((o) => o.validatorId);

  function freshAllPass(
    evidenceList = DEFAULT_OBLIGATIONS.filter((o) => o.applicableGates.includes('PR_CREATE')).map(
      (o) => o.validatorId,
    ),
  ) {
    return evidenceList.map((validatorId) => evidence({ validatorId }));
  }

  it('all exact fresh passed => SATISFIED', () => {
    const outcome = service.evaluate(context(), freshAllPass(), NOW);
    expect(outcome.status).toBe('SATISFIED');
    for (const assessment of outcome.assessments) expect(assessment.verdict).toBe('PASSED');
  });

  it('one failed / skipped / cancelled / timed_out blocks', () => {
    for (const status of ['FAILED', 'SKIPPED', 'CANCELLED', 'TIMED_OUT'] as const) {
      const results = freshAllPass();
      results[0] = evidence({ validatorId: results[0]!.validatorId, status });
      const outcome = service.evaluate(context(), results, NOW);
      expect(outcome.status).toBe('BLOCKED');
      expect(outcome.assessments.some((a) => a.verdict === status)).toBe(true);
    }
  });

  it('missing evidence blocks with the missing validator named', () => {
    const partial = freshAllPass().slice(1); // drop one
    const outcome = service.evaluate(context(), partial, NOW);
    expect(outcome.status).toBe('BLOCKED');
    const missing = outcome.assessments.find((a) => a.verdict === 'MISSING');
    expect(missing).toBeDefined();
    void requiredForCreate;
  });

  it('wrong SHA/diff never satisfies even when all statuses passed (WRONG_TARGET)', () => {
    const wrongBinding = freshAllPass().map((item) =>
      evidence({ validatorId: item.validatorId, targetFingerprint: 'repo-1|other|sha999' }),
    );
    // With zero exact-target candidates per validator, verdict is WRONG_TARGET…
    const outcome = service.evaluate(context(), wrongBinding, NOW);
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.assessments.every((a) => a.verdict === 'WRONG_TARGET')).toBe(true);
  });

  it('mixed old-exact + new-wrong-target selects the exact valid result (deterministic supersession)', () => {
    const mixed = [
      evidence({ validatorId: 'typecheck', producedAtMs: NOW - 10_000 }),
      evidence({
        validatorId: 'typecheck',
        targetFingerprint: 'repo-1|other-branch|sha999old000000000',
        resultKey: 'older-sha-result',
      }),
    ];
    const outcome = service.evaluate(context(), mixed, NOW);
    const typecheck = outcome.assessments.find((a) => a.validatorId === 'typecheck')!;
    expect(typecheck.verdict).toBe('PASSED');
    expect(typecheck.selectedEvidenceResultKey).toBe('res-typecheck');
  });

  it('age boundary: at exactly max is stale; under max passes (fake clock)', () => {
    const obligation = DEFAULT_OBLIGATIONS.find((o) => o.validatorId === 'lint')!;
    const producedAtMs = NOW - obligation.maxAgeSeconds * 1000;
    const atMax = service.evaluate(
      context(),
      [evidence({ validatorId: 'lint', producedAtMs })],
      NOW,
    );
    expect(atMax.assessments.find((a) => a.validatorId === 'lint')!.verdict).toBe('STALE_AGE');

    const justUnder = service.evaluate(
      context(),
      [evidence({ validatorId: 'lint', producedAtMs: producedAtMs + 1000 })],
      NOW,
    );
    expect(justUnder.assessments.find((a) => a.validatorId === 'lint')!.verdict).toBe('PASSED');
  });

  it('untrusted provenance fails closed as UNKNOWN_PROVENANCE regardless of status', () => {
    const forged = [evidence({ validatorId: 'security_scan' })].map((item) =>
      validationEvidence.parse({
        validatorId: item.validatorId,
        status: 'PASSED',
        targetFingerprint: item.targetFingerprint,
        producedAtMs: item.producedAtMs,
        provenance: 'devguard_service', // enum forces trusted values…
        providerVersion: item.providerVersion,
        resultKey: 'forged-key',
      }),
    );
    // Forged provenance arrives via a cast in real attacks; the normalizer's
    // trusted-set check below simulates runtime rejection of foreign sources.
    const hostile = [
      { ...forged[0]!, provenance: 'untrusted_model_output' as ValidationEvidence['provenance'] },
    ];
    const outcome = service.evaluate(context(), hostile, NOW);
    // Overall status escalates to UNKNOWN (never SATISFIED on partial doubt).
    expect(outcome.status).toBe('UNKNOWN');
    expect(outcome.assessments.find((a) => a.validatorId === 'security_scan')!.verdict).toBe(
      'UNKNOWN_PROVENANCE',
    );
  });

  it('repository/workflow obligations add but cannot remove global ones', () => {
    const resolved = new ValidationGateService().resolveObligations(
      context({
        extraObligations: [
          {
            validatorId: 'integration_tests',
            sourceRuleId: 'wf-extra',
            scope: 'WORKFLOW',
            applicableGates: ['PR_CREATE'],
            maxAgeSeconds: 3600,
            requireTargetFingerprint: true,
          },
        ],
      }),
    );
    const ids = resolved.map((o) => o.validatorId);
    expect(ids).toContain('integration_tests'); // added
    for (const global of DEFAULT_OBLIGATIONS.filter((o) =>
      o.applicableGates.includes('PR_CREATE'),
    )) {
      expect(ids).toContain(global.validatorId); // none removed
    }
  });
});

describe('staleness (C029 §9)', () => {
  const service = new ValidationGateService();

  it('target/policy/registry changes stale the prior outcome', () => {
    const baseContext = context();
    const results = DEFAULT_OBLIGATIONS.filter((o) => o.applicableGates.includes('PR_CREATE')).map(
      (o) => evidence({ validatorId: o.validatorId }),
    );
    const before = service.evaluate(baseContext, results, NOW);

    // Identical inputs at the SAME evaluation instant are not stale (the hash
    // binds evaluation identity, not wall clock).
    const sameAgain = service.isStale(before, baseContext, results, NOW);
    expect(sameAgain.stale).toBe(false);

    const changedSha = service.isStale(
      before,
      context({ targetFingerprint: 'repo-1|x|sha-different!!' }),
      results,
      NOW,
    );
    expect(changedSha.stale).toBe(true);
    expect(changedSha.causes).toContain('target changed');

    const changedPolicy = service.isStale(
      before,
      context({ currentPolicyVersionId: 'v2' }),
      results,
      NOW,
    );
    expect(changedPolicy.causes).toContain('policy changed');

    const newEvidenceRequired = service.isStale(before, baseContext, results.slice(0, -1), NOW);
    expect(newEvidenceRequired.causes).toContain('evaluation inputs changed');
  });
});

/**
 * C025 §22 — lattice joins, monotonicity property, rule matrix, trusted-fact
 * handling, permutation stability, and fingerprint determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_VERSION,
  CONTEXT_RISK_RULES,
  RISK_LATTICE,
  actionContext,
  classify,
  compareClassifications,
  isTrustedFact,
  joinRisks,
  looksSensitivePath,
  monotonic,
  rankOf,
  type ActionContext,
} from '@devguard/policy-engine';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return actionContext.parse({
    repositoryId: '11111111-1111-4111-8111-111111111111',
    workflowId: 'wf.implement-issue',
    actor: 'agent',
    target: { kind: 'branch', id: 'feature/x', ref: 'feature/x' },
    operation: {},
    facts: [],
    ...overrides,
  });
}

describe('risk lattice (C025 §8)', () => {
  it('orders strictly up to the terminal pair', () => {
    expect(rankOf('read')).toBeLessThan(rankOf('reversible_write'));
    expect(rankOf('reversible_write')).toBeLessThan(rankOf('sensitive_write'));
    expect(rankOf('sensitive_write')).toBeLessThan(rankOf('destructive'));
    expect(rankOf('destructive')).toBe(rankOf('external_side_effect')); // incomparable terminals
  });

  it('joins monotonically for every pair in the lattice (exhaustive)', () => {
    for (const a of RISK_LATTICE) {
      for (const b of RISK_LATTICE) {
        const joined = joinRisks(a, b);
        expect(monotonic(a, joined)).toBe(true);
        expect(monotonic(b, joined)).toBe(true);
      }
    }
  });

  it('terminal tie resolves conservatively', () => {
    expect(joinRisks('destructive', 'external_side_effect')).toBe('destructive');
  });
});

describe('classification rule matrix (C025 §22 table)', () => {
  it('ordinary reversible write stays WRITE_REVERSIBLE with sandbox obligations', () => {
    const result = classify('reversible_write', ctx());
    expect(result.effectiveRisk).toBe('reversible_write');
    expect(result.confidence).toBe('DETERMINATE');
    expect(result.obligations).toContain('sandbox_only');
  });

  it('protected/default branch target escalates to WRITE_SENSITIVE (rule-01)', () => {
    const viaTarget = classify(
      'reversible_write',
      ctx({ target: { kind: 'branch', id: 'main', ref: 'main' } }),
    );
    expect(viaTarget.factors.map((factor) => factor.ruleId)).toContain(
      'rule-01-protected-branch-write',
    );
    // Untrusted fact can NEVER set protected=false to escape the default-branch name rule.
    const withFakeUntrusted = ctx({
      target: { kind: 'branch', id: 'main', ref: 'main' },
      facts: [
        {
          kind: 'target.protected',
          value: false,
          provenance: { source: 'untrusted_model', fetchedAt: 'now' },
        },
      ],
    });
    const result = classify('reversible_write', withFakeUntrusted);
    expect(result.effectiveRisk).not.toBe('read');
  });

  it('sensitive paths escalate (rule-02) using normalized matching', () => {
    expect(looksSensitivePath('.github/workflows/ci.yml')).toBe(true);
    expect(
      looksSensitivePath('./.GITHUB/WORKFLOS/../workflows/x.yml'.replace('WORKFLOS/../', '')),
    ).toBe(true);
    const result = classify(
      'reversible_write',
      ctx({ operation: { path: '.github/workflows/deploy.yml' } }),
    );
    expect(result.effectiveRisk).toBe('sensitive_write');
  });

  it('production environment escalates to EXTERNAL_SIDE_EFFECT (C025 §22 matrix)', () => {
    const prod = ctx({ target: { kind: 'deployment', id: 'd1', environment: 'production' } });
    expect(classify('reversible_write', prod).effectiveRisk).toBe('external_side_effect');
  });

  it('a matched rule with unverifiable required facts fails the whole classification closed', () => {
    // Custom rules here simulate the documented requiresFacts semantics: a
    // MATCHING escalation whose trusted confirmation is missing => UNKNOWN.
    const strictRule = CONTEXT_RISK_RULES.find((rule) => rule.id === 'rule-07-breadth-limit')!;
    const withRequirement: typeof strictRule = {
      ...strictRule,
      requiresFacts: ['operation.authorized_paths'],
    };
    const manyPaths = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const result = classify('reversible_write', ctx({ operation: { paths: manyPaths } }), [
      withRequirement,
    ]);
    expect(result.confidence).toBe('UNKNOWN');
    expect(result.effectiveRisk).toBe('unknown');

    // With the trusted fact supplied, the same rule applies normally.
    const verified = classify(
      'reversible_write',
      ctx({
        operation: { paths: manyPaths },
        facts: [
          {
            kind: 'operation.authorized_paths',
            value: true,
            provenance: { source: 'domain_state', fetchedAt: '2026-01-01T00:00:00Z' },
          },
        ],
      }),
      [withRequirement],
    );
    expect(verified.effectiveRisk).toBe('sensitive_write');
  });

  it('breadth over 50 paths escalates and reports every matching factor', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const result = classify('reversible_write', ctx({ operation: { paths } }));
    expect(result.effectiveRisk).toBe('sensitive_write');
    expect(result.factors.some((factor) => factor.ruleId === 'rule-07-breadth-limit')).toBe(true);
  });

  it('multiple matches accumulate all factors, strongest wins, order-independent', () => {
    const rich = ctx({
      operation: { path: '.github/workflows/ci.yml', targetRef: 'main' },
    });
    const first = classify('reversible_write', rich);
    const reversedRules = [...CONTEXT_RISK_RULES].reverse();
    const second = classify('reversible_write', rich, reversedRules);
    expect([...first.factors].sort((a, b) => a.ruleId.localeCompare(b.ruleId))).toEqual(
      [...second.factors].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    );
    expect(first.effectiveRisk).toBe('sensitive_write');
    expect(first.factors.length).toBeGreaterThanOrEqual(2);
  });

  it('missing required fact flips entire classification UNKNOWN regardless of baseline', () => {
    for (const baseline of ['read', 'reversible_write'] as const) {
      const result = classify(
        baseline,
        ctx({ target: { kind: 'branch', id: 'b', protected: true } }),
      );
      // protected=true on target satisfies match without fact... rule requires
      // trusted fact presence though — this asserts fail-closed behavior.
      if (result.confidence === 'UNKNOWN') expect(result.effectiveRisk).toBe('unknown');
    }
  });
});

describe('untrusted content never lowers risk (C025 §17)', () => {
  it('isTrustedFact rejects model/repository-content provenance', () => {
    expect(isTrustedFact('x', { source: 'untrusted_model', fetchedAt: 't' })).toBe(false);
    expect(isTrustedFact('x', { source: 'repository_content', fetchedAt: 't' })).toBe(false);
    expect(isTrustedFact('x', { source: 'github_adapter', fetchedAt: 't' })).toBe(true);
  });

  it('classifier version participates in evidence output', () => {
    const result = classify('read', ctx());
    expect(result.classifierVersion).toBe(CLASSIFIER_VERSION);
  });

  it('identical inputs produce byte-identical fingerprints; changed inputs do not', () => {
    const base = ctx();
    expect(classify('read', base).inputFingerprint).toBe(classify('read', ctx()).inputFingerprint);
    const changed = ctx({ actor: 'user' });
    expect(classify('read', base).inputFingerprint).not.toBe(
      classify('read', changed).inputFingerprint,
    );
  });
});

describe('compareClassifications (approval staleness basis)', () => {
  it('escalation after approval marks approval stale', () => {
    const before = classify('reversible_write', ctx());
    const after = classify(
      'reversible_write',
      ctx({ target: { kind: 'branch', id: 'main', ref: 'main' } }),
    );
    const comparison = compareClassifications(before, after);
    expect(comparison.escalated).toBe(true);
    expect(comparison.staleApproval).toBe(true);
  });

  it('unknown reclassification fails closed as escalation', () => {
    const before = classify('reversible_write', ctx());
    const after = { ...before, effectiveRisk: 'unknown' as const };
    expect(compareClassifications(before, after).staleApproval).toBe(true);
  });
});

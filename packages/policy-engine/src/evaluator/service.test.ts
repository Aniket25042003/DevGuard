/**
 * C030 §22 — the full precedence matrix, obligation non-weakening property,
 * current-vs-snapshot merge, persistence binding and dispatch verification.
 */
import { describe, expect, it } from 'vitest';
import {
  DecisionStoreUnavailableError,
  EVALUATOR_VERSION,
  PolicyEvaluationService,
  evaluatePrecedence,
  evaluationInputFingerprint,
  mergeSnapshotWithCurrent,
  type EvaluationInput,
} from '@devguard/policy-engine';

const SAFE_BASE: EvaluationInput = {
  actionId: 'issue_read',
  riskClass: 'read',
  repositoryDenyMatch: false,
  globalDenyMatch: false,
  globalApprovalFloorMatch: false,
  workflowPermitted: true,
  // Ceiling RESOLVED with no restriction for reads => 'ALLOW'; only an
  // unresolvable ceiling is 'undefined' (which fails closed).
  ceilingEffect: 'ALLOW',
  contextRequiresApproval: false,
  sandboxRequired: false,
  gateSatisfied: undefined,
  gateRequired: false,
  explicitAllowMatch: false,
  explicitRequireApprovalMatch: false,
  explicitDenyMatch: false,
  exactValidApprovalPresent: false,
};

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return { ...SAFE_BASE, ...overrides };
}

describe('precedence matrix (C030 §22 rows)', () => {
  const evaluate = evaluatePrecedence;

  it('row 1: global DENY beats repository allow + approval', () => {
    expect(
      evaluate(
        input({ globalDenyMatch: true, explicitAllowMatch: true, exactValidApprovalPresent: true }),
      ),
    ).toMatchObject({
      effect: 'DENY',
      reasonCode: 'GLOBAL_SAFETY_DENY',
    });
  });

  it('row 2: repository deny is absolute', () => {
    expect(
      evaluate(input({ repositoryDenyMatch: true, exactValidApprovalPresent: true })),
    ).toMatchObject({ effect: 'DENY' });
  });

  it('row 3-4: unknown dimension / unpermitted workflow deny even with approval + allow', () => {
    expect(evaluate(input({ actionId: undefined, exactValidApprovalPresent: true }))).toMatchObject(
      { effect: 'DENY', reasonCode: 'UNKNOWN_CAPABILITY' },
    );
    expect(
      evaluate(input({ workflowPermitted: false, exactValidApprovalPresent: true })),
    ).toMatchObject({ effect: 'DENY' });
  });

  it('row 5: hard autonomy ceiling denies despite approval', () => {
    expect(
      evaluate(input({ ceilingEffect: 'DENY', exactValidApprovalPresent: true })),
    ).toMatchObject({
      effect: 'DENY',
      reasonCode: 'AUTONOMY_CEILING_EXCEEDED',
    });
  });

  it('rows 6-7: approval floors REQUIRE_APPROVAL; exact fresh approval satisfies them (never DENY)', () => {
    const floored = evaluate(input({ ceilingEffect: 'REQUIRE_APPROVAL' }));
    expect(floored.effect).toBe('REQUIRE_APPROVAL');
    expect(
      evaluate(input({ ceilingEffect: 'REQUIRE_APPROVAL', exactValidApprovalPresent: true }))
        .effect,
    ).toBe('ALLOW');

    const protectedMerge = evaluate(
      input({
        actionId: 'pull_request_merge',
        riskClass: 'destructive',
        ceilingEffect: 'REQUIRE_APPROVAL',
        mergesProtectedBranch: true,
        explicitAllowMatch: true,
      }),
    );
    expect(protectedMerge.effect).toBe('REQUIRE_APPROVAL'); // repo allow cannot remove the floor
  });

  it('approval NEVER overrides deny (stage order proof)', () => {
    const attempt = evaluate(
      input({
        repositoryDenyMatch: true,
        ceilingEffect: 'REQUIRE_APPROVAL',
        contextRequiresApproval: true,
        exactValidApprovalPresent: true,
        explicitAllowMatch: true,
      }),
    );
    expect(attempt.effect).toBe('DENY');
  });

  it('sandbox obligation never flips effect; composes with both ALLOW and REQUIRE_APPROVAL', () => {
    expect(evaluate(input({ sandboxRequired: true })).obligations.map((o) => o.kind)).toContain(
      'execution_environment',
    );
    const gated = evaluate(input({ sandboxRequired: true, ceilingEffect: 'REQUIRE_APPROVAL' }));
    expect(gated.effect).toBe('REQUIRE_APPROVAL');
    expect(gated.obligations.map((o) => o.kind)).toContain('execution_environment');
  });

  it('context escalation requires approval and only escalates', () => {
    expect(evaluate(input({ contextRequiresApproval: true })).effect).toBe('REQUIRE_APPROVAL');
  });

  it('risk defaults apply when nothing explicit decided (read/reversible allow, elevated approve)', () => {
    expect(evaluate(input()).effect).toBe('ALLOW'); // read default
    expect(
      evaluatePrecedence(
        input({ actionId: 'branch_push', riskClass: 'reversible_write', sandboxRequired: true }),
      ).effect,
    ).toBe('ALLOW');
    expect(
      evaluate(
        input({
          actionId: 'issue_destructive_close',
          riskClass: 'destructive',
          explicitAllowMatch: false,
        }),
      ).effect,
    ).toBe('REQUIRE_APPROVAL');
  });

  it('no rule/default mapping fails closed as DENY (stage 10)', () => {
    const result = evaluate(input({ riskClass: undefined }));
    expect(result.effect).toBe('DENY');
    expect(result.reasonCode).toBe('UNKNOWN_CAPABILITY');
  });

  it('all matched rules are retained, sorted by stage then rule ID', () => {
    const result = evaluate(
      input({
        actionId: 'branch_push',
        riskClass: 'reversible_write',
        sandboxRequired: true,
        contextRequiresApproval: true,
        ceilingEffect: 'REQUIRE_APPROVAL',
        mergesProtectedBranch: true,
        explicitAllowMatch: true,
        exactValidApprovalPresent: true,
      }),
    );
    const stages = result.matchedRules.map((r) => r.stage);
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
    expect(result.matchedRules.length).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic byte-for-byte on identical inputs', () => {
    const a = evaluatePrecedence(input());
    const b = evaluatePrecedence(input());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('current vs snapshot merge (mid-run semantics)', () => {
  const snapshotDeny = {
    effect: 'DENY' as const,
    reasonCode: 'R1',
    matchedRules: [],
    obligations: [],
    explanation: '',
  };
  const snapshotAllow = {
    effect: 'ALLOW' as const,
    reasonCode: 'R2',
    matchedRules: [],
    obligations: [],
    explanation: '',
  };
  const currentApprove = {
    effect: 'REQUIRE_APPROVAL' as const,
    reasonCode: 'R3',
    matchedRules: [],
    obligations: [],
    explanation: '',
  };

  it('stricter current wins immediately', () => {
    const merged = mergeSnapshotWithCurrent(snapshotAllow, currentApprove);
    expect(merged.effect).toBe('REQUIRE_APPROVAL');
    expect(merged.requireFreshDecision).toBe(false);
  });

  it('looser current NEVER silently elevates a denied/paused action', () => {
    const merged = mergeSnapshotWithCurrent(snapshotDeny, snapshotAllow);
    expect(merged.effect).toBe('DENY');
    expect(merged.requireFreshDecision).toBe(true);
    expect(merged.explanation).toContain('NO silent elevation');
  });

  it('equal effects need nothing new', () => {
    expect(mergeSnapshotWithCurrent(snapshotAllow, snapshotAllow).requireFreshDecision).toBe(false);
  });
});

describe('persistence & dispatch binding (C030 §13/§17)', () => {
  function makeService(persistOutcome: 'ok' | 'fail') {
    let persisted = 0;
    const service = new PolicyEvaluationService(
      {
        persistAttemptAndDecision: async () => {
          if (persistOutcome === 'fail') throw new Error('db down');
          persisted += 1;
          return { persisted: true };
        },
      },
      (() => {
        let n = 0;
        return () => `dec-${++n}`;
      })(),
    );
    return { service, getPersisted: () => persisted };
  }

  const REQUEST_BASE = {
    ...SAFE_BASE,
    repositoryId: 'repo-1',
    workflowRunId: 'run-1',
    actionOperationKey: 'opkey:issue.read:7',
    policySnapshotId: 'snap-1',
    currentPolicyVersionId: 'v1',
    globalSafetyVersionId: 'global-safety@1',
    registrySnapshotId: 'registry-abc',
  };

  it('evaluateAndPersist persists before returning; replay with same fingerprint yields same decision', async () => {
    const first = makeService('ok');
    const decision = await first.service.evaluateAndPersist(REQUEST_BASE);
    expect(first.getPersisted()).toBe(1);
    expect(decision.effect).toBe('ALLOW');
    expect(decision.evaluatorVersion).toBe(EVALUATOR_VERSION);

    // Same inputs produce identical fingerprint.
    expect(evaluationInputFingerprint(REQUEST_BASE)).toBe(evaluationInputFingerprint(REQUEST_BASE));
  });

  it('persistence failure blocks ANY dispatch (fail closed, no half state)', async () => {
    const failing = makeService('fail');
    await expect(failing.service.evaluateAndPersist(REQUEST_BASE)).rejects.toThrow(
      DecisionStoreUnavailableError,
    );
  });

  it('dispatch tokens verify against committed fingerprints and expire', async () => {
    const svc = makeService('ok').service;
    const nowMs = 1_700_000_000_000;
    const record = await svc.evaluateAndPersist(REQUEST_BASE, { nowMs });
    const token = PolicyEvaluationService.issueToken(record, 60_000, nowMs);

    expect(
      svc.verifyDispatch(token, { inputFingerprint: record.inputFingerprint, nowMs: nowMs + 1000 })
        .allowed,
    ).toBe(true);
    expect(
      svc.verifyDispatch(token, { inputFingerprint: 'changed-sha-anything', nowMs: nowMs + 1000 }),
    ).toMatchObject({
      allowed: false,
      reasonCode: 'CONTEXT_CHANGED',
    });
    expect(
      svc.verifyDispatch(token, {
        inputFingerprint: record.inputFingerprint,
        nowMs: nowMs + 61_000,
      }),
    ).toMatchObject({
      allowed: false,
      reasonCode: 'DECISION_STALE',
    });
  });

  it('denied operations still persist an immutable decision (audit)', async () => {
    const store = makeService('ok');
    const record = await store.service.evaluateAndPersist({
      ...REQUEST_BASE,
      actionId: 'repository_delete',
      riskClass: 'destructive',
      globalDenyMatch: true,
    });
    expect(record.effect).toBe('DENY');
    expect(store.getPersisted()).toBe(1);
  });
});

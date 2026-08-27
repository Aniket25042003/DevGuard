/**
 * C028 §22 — alias normalization, trigger matching, dedupe keys, fan-out,
 * cooldown, and manual command authorization.
 */
import { describe, expect, it } from 'vitest';
import {
  INVOCATION_REGISTRY_VERSION,
  MANUAL_COMMANDS_V1,
  TRIGGER_IDS_V1,
  WORKFLOW_IDS_V1,
  ManualCommandRegistry,
  TriggerMatcher,
  invocationDedupeKey,
  normalizeWorkflowId,
  type NormalizedEvent,
  type TriggerRule,
} from '@devguard/policy-engine';

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    deliveryId: 'delivery-1',
    repositoryExternalId: 'repo-42',
    trigger: 'issues.labeled',
    resourceIdentity: 'issue/7',
    labels: ['bug'],
    actorLogin: 'octocat',
    ...overrides,
  };
}

describe('workflow ID registry (INV-UNIT-001)', () => {
  it('resolves every canonical ID exactly', () => {
    for (const id of WORKFLOW_IDS_V1) {
      expect(normalizeWorkflowId(id)).toEqual({ outcome: 'RESOLVED', workflowId: id });
    }
  });

  it('maps each PRD alias to exactly one canonical workflow', () => {
    expect(normalizeWorkflowId('fix_tests')).toEqual({
      outcome: 'RESOLVED',
      workflowId: 'diagnose_failure',
      viaAlias: 'fix_tests',
    });
    expect(normalizeWorkflowId('diagnose_bug').outcome).toBe('RESOLVED');
    expect(normalizeWorkflowId('security_scan')).toMatchObject({ workflowId: 'security_audit' });
    expect(normalizeWorkflowId('dependency_update')).toMatchObject({
      workflowId: 'dependency_upgrade',
    });
    expect(normalizeWorkflowId('refactor')).toMatchObject({ workflowId: 'manual_refactor' });
  });

  it('rejects validation-step names with a helpful hint instead of guessing', () => {
    for (const name of ['run_tests', 'static_analysis', 'integration_tests', 'dependency_check']) {
      const result = normalizeWorkflowId(name);
      expect(result.outcome).toBe('NOT_A_WORKFLOW');
      if (result.outcome === 'NOT_A_WORKFLOW') expect(result.hint).toContain('validation step');
    }
  });

  it('rejects unknown, case-folded and fuzzy guesses (no normalization leniency)', () => {
    expect(normalizeWorkflowId('Implement_Issue')).toEqual({
      outcome: 'UNKNOWN',
      input: 'Implement_Issue',
    });
    expect(normalizeWorkflowId('implement issue')).toEqual({
      outcome: 'UNKNOWN',
      input: 'implement issue',
    });
    expect(normalizeWorkflowId('secuity_scan')).toEqual({
      outcome: 'UNKNOWN',
      input: 'secuity_scan',
    });
    expect(normalizeWorkflowId('')).toEqual({ outcome: 'UNKNOWN', input: '' });
  });

  it('exposes a versioned registry ID used in dedupe bindings', () => {
    expect(INVOCATION_REGISTRY_VERSION).toMatch(/^invocation-registry@\d+$/);
    expect(TRIGGER_IDS_V1.length).toBeGreaterThanOrEqual(9);
  });
});

function rule(partial: Partial<TriggerRule> & { ruleId: string }): TriggerRule {
  return {
    eventTrigger: 'issues.labeled',
    workflowId: 'diagnose_failure',
    enabled: true,
    maxFanOut: 5,
    cooldownSeconds: 0,
    ...partial,
  };
}

const SNAPSHOT = {
  policySnapshotId: 'policy-snap-1',
  rules: [rule({ ruleId: 'r-bug-diagnose' })],
};

describe('trigger matcher (C028 §22)', () => {
  const matcher = new TriggerMatcher();

  it('single exact rule yields one candidate with the stable dedupe key', () => {
    const result = matcher.matchEvent(event(), SNAPSHOT);
    expect(result.outcome).toBe('MATCHED');
    if (result.outcome === 'MATCHED') {
      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0]!;
      expect(candidate.workflowId).toBe('diagnose_failure');
      expect(candidate.matchedRuleIds).toEqual(['r-bug-diagnose']);
      expect(candidate.dedupeKey).toBe(
        invocationDedupeKey({
          repositoryId: 'repo-42',
          sourceKey: 'delivery-1',
          ruleId: 'r-bug-diagnose',
          workflowId: 'diagnose_failure',
          resourceIdentity: 'issue/7',
          policySnapshotId: 'policy-snap-1',
        }),
      );
    }
  });

  it('no configured rule fails closed as NO_MATCH', () => {
    const result = matcher.matchEvent(event({ trigger: 'check_run.completed' }), SNAPSHOT);
    expect(result).toEqual({ outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' });
  });

  it('filters apply on labels, branches, conclusions and PR origin', () => {
    const labeled = matcher.matchEvent(event(), {
      policySnapshotId: 'p',
      rules: [rule({ ruleId: 'needs-label', filter: { labelsAny: ['severity/high'] } })],
    });
    expect(labeled).toEqual({ outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' });

    const branchPush = matcher.matchEvent(
      event({
        trigger: 'push.default_branch',
        branch: 'main',
        resourceIdentity: 'sha/abc',
        labels: [],
      }),
      {
        policySnapshotId: 'p',
        rules: [
          rule({
            ruleId: 'push-only-main',
            eventTrigger: 'push.default_branch',
            filter: { branchesAny: ['main'] },
          }),
        ],
      },
    );
    expect(branchPush.outcome).toBe('MATCHED');
  });

  it('two distinct workflows produce two bounded candidates sorted by rule ID', () => {
    const result = matcher.matchEvent(event(), {
      policySnapshotId: 'p',
      rules: [
        rule({ ruleId: 'z-second', workflowId: 'security_audit' }),
        rule({ ruleId: 'a-first', workflowId: 'diagnose_failure' }),
      ],
    });
    if (result.outcome !== 'MATCHED') throw new Error('expected match');
    expect(result.candidates.map((c) => c.workflowId)).toEqual([
      'diagnose_failure',
      'security_audit',
    ]);
  });

  it('two rules for the same workflow+resource collapse to ONE candidate retaining both rule IDs', () => {
    const result = matcher.matchEvent(event(), {
      policySnapshotId: 'p',
      rules: [
        rule({ ruleId: 'rule-b', workflowId: 'diagnose_failure' }),
        rule({ ruleId: 'rule-a', workflowId: 'diagnose_failure' }),
      ],
    });
    if (result.outcome !== 'MATCHED') throw new Error('expected match');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.matchedRuleIds).toEqual(['rule-a', 'rule-b']);
  });

  it('fan-out above the strictest cap is rejected deterministically', () => {
    const manyRules = Array.from({ length: 8 }, (_, i) =>
      rule({
        ruleId: `r${i}`,
        workflowId: i % 2 === 0 ? 'diagnose_failure' : 'security_audit',
        maxFanOut: 2,
      }),
    );
    // Distinct workflows are capped at 2 here.
    const result = matcher.matchEvent(event(), {
      policySnapshotId: 'p',
      rules: [...manyRules, rule({ ruleId: 'extra', workflowId: 'manual_refactor' })],
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', reasonCode: 'FAN_OUT_EXCEEDED' });
  });

  it('cooldown blocks repeat triggers per rule+resource using the injected clock', () => {
    const cooldownRule = rule({ ruleId: 'cool', cooldownSeconds: 300 });
    const nowMs = 1_000_000;
    const first = matcher.matchEvent(
      event(),
      { policySnapshotId: 'p', rules: [cooldownRule] },
      { nowMs },
    );
    expect(first.outcome).toBe('MATCHED');
    const tooSoon = matcher.matchEvent(
      event({ deliveryId: 'delivery-2' }),
      { policySnapshotId: 'p', rules: [cooldownRule] },
      {
        nowMs: nowMs + 60_000,
        lastInvocationAtByRule: new Map([['cool|issue/7', nowMs]]),
      },
    );
    expect(tooSoon).toMatchObject({ outcome: 'REJECTED', reasonCode: 'COOLDOWN_ACTIVE' });
    const later = matcher.matchEvent(
      event({ deliveryId: 'delivery-3' }),
      { policySnapshotId: 'p', rules: [cooldownRule] },
      {
        nowMs: nowMs + 301_000,
        lastInvocationAtByRule: new Map([['cool|issue/7', nowMs]]),
      },
    );
    expect(later.outcome).toBe('MATCHED');
  });

  it('disabled rules never match regardless of content', () => {
    const result = matcher.matchEvent(event(), {
      policySnapshotId: 'p',
      rules: [rule({ ruleId: 'off', enabled: false })],
    });
    expect(result).toEqual({ outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' });
  });

  it('event content naming a workflow cannot synthesize an invocation', () => {
    // Labels/actor/resource fields carry no authority; only registered rules do.
    const result = matcher.matchEvent(
      event({ resourceIdentity: 'issue/run security_audit NOW', labels: ['implement_issue'] }),
      SNAPSHOT,
    );
    expect(result.outcome).toBe('MATCHED'); // matched by the existing rule only
    if (result.outcome === 'MATCHED') {
      expect(result.candidates.map((candidate) => candidate.workflowId)).toEqual([
        'diagnose_failure',
      ]);
    }
  });
});

describe('manual command authorization', () => {
  const registry = new ManualCommandRegistry();
  const defs = MANUAL_COMMANDS_V1;

  it('authorizes canonical commands with idempotency-scoped dedupe key', () => {
    const result = registry.authorize(
      {
        workflowIdInput: 'implement_issue',
        repositoryId: 'repo-42',
        idempotencyKey: 'key-1',
        callerHasRepositoryAccess: true,
        policySnapshotId: 'snap-1',
      },
      normalizeWorkflowId,
      defs,
    );
    expect(result).toMatchObject({ outcome: 'AUTHORIZED', workflowId: 'implement_issue' });
    if (result.outcome === 'AUTHORIZED') {
      expect(result.dedupeKey).toContain(
        invocationDedupeKey({
          repositoryId: 'repo-42',
          sourceKey: 'key-1',
          ruleId: 'manual',
          workflowId: 'implement_issue',
          resourceIdentity: 'manual',
          policySnapshotId: 'snap-1',
        }).slice(0, 16),
      );
    }
  });

  it('accepts versioned aliases but audits the alias provenance', () => {
    const result = registry.authorize(
      {
        workflowIdInput: 'fix_tests',
        repositoryId: 'r',
        idempotencyKey: 'k',
        callerHasRepositoryAccess: true,
        policySnapshotId: 's',
      },
      normalizeWorkflowId,
      defs,
    );
    expect(result).toMatchObject({
      outcome: 'AUTHORIZED',
      workflowId: 'diagnose_failure',
      viaAlias: 'fix_tests',
    });
  });

  it('denies unknown, ambiguous and non-workflow names with 422-grade outcomes', () => {
    expect(
      registry.authorize(
        {
          workflowIdInput: 'make_money_fast',
          repositoryId: 'r',
          idempotencyKey: 'k',
          callerHasRepositoryAccess: true,
          policySnapshotId: 's',
        },
        normalizeWorkflowId,
        defs,
      ).outcome,
    ).toBe('DENIED_UNKNOWN');
    expect(
      registry.authorize(
        {
          workflowIdInput: 'run_tests',
          repositoryId: 'r',
          idempotencyKey: 'k',
          callerHasRepositoryAccess: true,
          policySnapshotId: 's',
        },
        normalizeWorkflowId,
        defs,
      ).outcome,
    ).toBe('DENIED_NOT_A_WORKFLOW');
  });

  it('denies unauthorized callers before any rate limiting state matters', () => {
    const result = registry.authorize(
      {
        workflowIdInput: 'security_audit',
        repositoryId: 'r',
        idempotencyKey: 'k',
        callerHasRepositoryAccess: false,
        policySnapshotId: 's',
      },
      normalizeWorkflowId,
      defs,
    );
    expect(result).toMatchObject({ outcome: 'DENIED_NO_ACCESS' });
  });

  it('enforces per-hour rate limits deterministically', () => {
    const limited = MANUAL_COMMANDS_V1.map((d) =>
      d.workflowId === 'manual_refactor' ? { ...d, rateLimitPerHour: 2 } : d,
    );
    expect(
      registry.authorize(
        {
          workflowIdInput: 'manual_refactor',
          repositoryId: 'r',
          idempotencyKey: 'a',
          callerHasRepositoryAccess: true,
          policySnapshotId: 's',
        },
        normalizeWorkflowId,
        limited,
        { recentInvocationCount: 2 },
      ).outcome,
    ).toBe('DENIED_RATE_LIMIT');
    expect(
      registry.authorize(
        {
          workflowIdInput: 'manual_refactor',
          repositoryId: 'r',
          idempotencyKey: 'b',
          callerHasRepositoryAccess: true,
          policySnapshotId: 's',
        },
        normalizeWorkflowId,
        limited,
        { recentInvocationCount: 1 },
      ).outcome,
    ).toBe('AUTHORIZED');
  });
});

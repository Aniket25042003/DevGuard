import { describe, expect, it } from 'vitest';
import '../errors.js';
import { WorkflowExecutor, RetryClassifier, InMemoryLockManager } from './executor.js';
import { ValidationAggregator } from '../validation/aggregator.js';
import type { ValidationResult } from '../validation/aggregator.js';

describe('C047 executor', () => {
  it('classifies retryability by typed code, not model text', () => {
    const c = new RetryClassifier();
    expect(c.classify({ code: 'POLICY_DENIED' }).kind).toBe('no_retry');
    expect(c.classify({ code: 'COMMAND_OUTCOME_UNKNOWN' }).kind).toBe('reconcile');
    expect(c.classify({ code: 'RATE_LIMITED' }).kind).toBe('safe');
  });

  it('runs a step handler under ordered locks and releases on success', async () => {
    const handler = { stepKind: 'turn', run: async () => ({ ok: true as const }) };
    const locks = new InMemoryLockManager();
    const executor = new WorkflowExecutor({
      handlers: new Map([['turn', handler]]),
      locks,
      retries: new RetryClassifier(),
      command: { dispatch: async () => undefined, verifyCancellationSupported: async () => true },
    });
    const r = await executor.execute(
      {
        runId: 'r1',
        stepId: 's1',
        executionGeneration: 0,
        cancellationGeneration: 0,
        traceId: 't',
        attempt: 0,
      },
      'turn',
      ['repo:r:branch:b'],
    );
    expect(r.ok).toBe(true);
    expect(locks.locks.get('repo:r:branch:b')?.state).toBe('RELEASED');
  });

  it('returns RESOURCE_LOCKED when a lock is held and exhausts budget', async () => {
    const handler = { stepKind: 'command', run: async () => ({ ok: true as const }) };
    const locks = new InMemoryLockManager();
    const executor = new WorkflowExecutor({
      handlers: new Map([['command', handler]]),
      locks,
      retries: new RetryClassifier(),
      command: { dispatch: async () => undefined, verifyCancellationSupported: async () => true },
    });
    await locks.acquire('repo:r:branch:b', 'other-run', 1000);
    const r = await executor.execute(
      {
        runId: 'r1',
        stepId: 's1',
        executionGeneration: 0,
        cancellationGeneration: 0,
        traceId: 't',
        attempt: 0,
      },
      'command',
      ['repo:r:branch:b'],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retry.kind).toBe('no_retry');
      expect(r.retry.terminalCode).toBe('RESOURCE_LOCKED');
    }
  });
});

describe('C048 validation aggregate gate', () => {
  const evidence = {
    runId: 'r1',
    completedItems: ['s1'],
    notCompletedItems: [],
    artifactScanStates: {},
    requiredArtifactIds: ['art-1'],
    prPendingApproval: false,
  };

  function result(status: ValidationResult['status'], mandatory = true): ValidationResult {
    return {
      validatorId: 'v1',
      validatorVersion: '1',
      status,
      mandatory,
      targetSha: 'a'.repeat(40),
      observedAtIso: '2026-08-28T00:00:00.000Z',
      validUntilIso: '2099-01-01T00:00:00.000Z',
      findingIds: [],
    };
  }

  it('is SATISFIED only when all mandatory validations are PASSED', () => {
    const agg = new ValidationAggregator();
    expect(
      agg.aggregate([result('PASSED')], { ...evidence, artifactScanStates: { 'art-1': 'SAFE' } })
        .gate,
    ).toBe('SATISFIED');
    expect(
      agg.aggregate([result('FAILED')], { ...evidence, artifactScanStates: { 'art-1': 'SAFE' } })
        .gate,
    ).toBe('UNSATISFIED');
  });

  it('blocks when a required artifact is not SAFE', () => {
    const agg = new ValidationAggregator();
    const verdict = agg.aggregate([result('PASSED')], {
      ...evidence,
      artifactScanStates: { 'art-1': 'QUARANTINED' },
    });
    expect(verdict.gate).toBe('UNSATISFIED');
  });
});

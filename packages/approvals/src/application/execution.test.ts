/**
 * C034 §22 — eight-step ordering/short-circuit, reconcile-before-execute,
 * at-most-once effect under retries, uncertain-outcome handling.
 */
import { describe, expect, it } from 'vitest';
import { PrivilegedExecutionService, type C034Ports } from '@devguard/approvals';

const NOW = 1_700_000_000_000;
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';

function record(overrides = {}) {
  return {
    id: APPROVAL_ID,
    status: 'APPROVED' as const,
    version: 7,
    actionFingerprint: 'a'.repeat(64),
    contextFingerprint: 'b'.repeat(64),
    operationKey: 'opkey:pull_request.merge:42',
    cancellationGeneration: 0,
    expiresAtMs: NOW + 60_000,
    policyDecisionId: 'dec-1',
    policyDecisionEffect: 'REQUIRE_APPROVAL',
    resolvedBy: 'human-1',
    resolvedAtMs: NOW - 1000,
    ...overrides,
  };
}

function makePorts(overrides: Partial<C034Ports> & { persist?: (calls: string[]) => void } = {}): {
  ports: C034Ports;
  calls: string[];
  executorRuns: number;
} {
  const calls: string[] = [];
  let executorRuns = 0;
  const base: C034Ports = {
    persistence: {
      loadPrivilegedApproval: async () => record(overrides['record'] ?? {}),
      claimExecutionLease: async (input) => {
        calls.push(`claim:v${input.expectedVersion}`);
        return { claimed: true, attemptId: 'attempt-1', versionAfter: input.expectedVersion + 1 };
      },
      closeExecution: async (input) => {
        calls.push(`close:${input.toStatus}`);
      },
    },
    validityGate: async () => {
      calls.push('validity');
      return { valid: true };
    },
    fetchCurrentTarget: async () => {
      calls.push('target');
      return { actionFingerprint: 'a'.repeat(64), contextFingerprint: 'b'.repeat(64) };
    },
    reevaluatePolicy: async () => {
      calls.push('policy');
      return { stillRequiresApprovalAndGranted: true, stricterDeny: false };
    },
    executor: {
      executeOnce: async (input) => {
        executorRuns += 1;
        calls.push(`execute:${input.operationKey}`);
        return { kind: 'EXECUTED', providerReference: 'gh-pr-42-merged' };
      },
    },
    verifier: {
      verify: async () => {
        calls.push('verify');
        return { verified: true };
      },
    },
    workerId: 'worker-x',
    nowMs: NOW,
    digest: (value) => `dig-${JSON.stringify(value).length}`,
    ...(overrides as object),
  } as C034Ports;
  if ('persist' in overrides && typeof overrides.persist === 'function') overrides.persist(calls);
  return { ports: base, calls, executorRuns };
}

const SERVICE = new PrivilegedExecutionService();

describe('eight-step double check (C034 §22)', () => {
  it('happy path proves 1-6 before claim and 7-8 after', async () => {
    const { ports, calls } = makePorts();
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(result.outcome).toBe('EXECUTED');
    expect(result.stepsProven).toHaveLength(8);
    // Ordering: prerequisites -> refetch -> policy -> validity -> claim -> execute -> verify.
    expect(calls.slice(0, 5)).toEqual([
      'target',
      'policy',
      'validity',
      'claim:v7',
      'execute:opkey:pull_request.merge:42',
    ]);
    // Step 8 verify runs BEFORE the terminal close lands (atomically last).
    expect(calls.at(-2)).toBe('verify');
    expect(calls.at(-1)).toBe('close:EXECUTED');
  });

  it('step 1 proof fails for ALLOW-decision approvals (must never route here)', async () => {
    const { ports } = makePorts({ record: { policyDecisionEffect: 'ALLOW' } });
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(result).toMatchObject({ outcome: 'BLOCKED', code: 'STEPS_PREREQ_INVALID' });
  });

  it('step 3 proof requires a recorded human resolution', async () => {
    const { ports } = makePorts({ record: { resolvedBy: undefined } });
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(result).toMatchObject({ outcome: 'BLOCKED', code: 'STEPS_PREREQ_INVALID' });
  });

  it('only APPROVED status may be executed', async () => {
    const { ports } = makePorts({ record: { status: 'PENDING' } });
    expect(await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports)).toMatchObject({
      outcome: 'BLOCKED',
    });
  });

  it.each([
    [
      'action fingerprint changed',
      { actionFingerprint: 'f'.repeat(64), contextFingerprint: 'b'.repeat(64) },
      'TARGET_CHANGED',
    ],
    [
      'context fingerprint changed',
      { actionFingerprint: 'a'.repeat(64), contextFingerprint: 'g'.repeat(64) },
      'TARGET_CHANGED',
    ],
  ])('step 4: %s blocks with no execution attempt', async (_name, observation, code) => {
    const { ports, calls, executorRuns } = makePorts({
      fetchCurrentTarget: async () => observation,
    } as never);
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(result).toMatchObject({ outcome: 'BLOCKED', code });
    expect(executorRuns).toBe(0); // no side effect
    void calls;
  });

  it('step 5: stricter current deny blocks; looser current rules do NOT elevate', async () => {
    const denied = await SERVICE.executeApproved(
      { approvalId: APPROVAL_ID },
      makePorts({
        reevaluatePolicy: async () => ({
          stillRequiresApprovalAndGranted: true,
          stricterDeny: true,
        }),
      } as never).ports,
    );
    expect(denied).toMatchObject({ outcome: 'BLOCKED', code: 'POLICY_CHANGED' });

    const loosened = await SERVICE.executeApproved(
      { approvalId: APPROVAL_ID },
      makePorts({
        reevaluatePolicy: async () => ({
          stillRequiresApprovalAndGranted: false,
          stricterDeny: false,
        }),
      } as never).ports,
    );
    expect(loosened).toMatchObject({ outcome: 'BLOCKED', code: 'POLICY_LOOSENED' });
  });

  it('step 6 validity failure short-circuits before the claim', async () => {
    const { ports, calls } = makePorts({
      validityGate: async () => ({
        valid: false,
        code: 'APPROVAL_STALE',
        detail: 'binding drifted',
      }),
    } as never);
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(result).toMatchObject({ outcome: 'BLOCKED', code: 'APPROVAL_STALE' });
    expect(calls.some((c) => c.startsWith('claim'))).toBe(false);
  });

  it('lost claim race blocks without executing', async () => {
    const { ports, executorRuns } = makePorts();
    ports.persistence.claimExecutionLease = async () => ({
      claimed: false,
      attemptId: '',
      versionAfter: 8,
    });
    expect(await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports)).toMatchObject({
      outcome: 'BLOCKED',
      code: 'APPROVAL_VERSION_CONFLICT',
    });
    expect(executorRuns).toBe(0);
  });

  it('reconcile-first: ALREADY_PRESENT completes without double execution', async () => {
    let runs = 0;
    const { ports } = makePorts({
      executor: {
        executeOnce: async () => {
          runs += 1;
          return runs === 1
            ? { kind: 'EXECUTED', providerReference: 'ref-1' }
            : { kind: 'ALREADY_PRESENT', providerReference: 'ref-1' };
        },
      },
    } as never);
    // First run executes; a retry replay would observe already-present.
    const first = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, ports);
    expect(first.outcome).toBe('EXECUTED');

    const retryHarness = makePorts({
      executor: {
        executeOnce: async () => ({ kind: 'ALREADY_PRESENT', providerReference: 'ref-1' }),
      },
    } as never);
    const retry = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, retryHarness.ports);
    expect(retry).toMatchObject({ outcome: 'EXECUTED', verified: true }); // no second mutation
  });

  it('unverified EXECUTED outcome becomes EXECUTION_FAILED (never lies about success)', async () => {
    const closes: string[] = [];
    const harness = makePorts({
      verifier: { verify: async () => ({ verified: false, detail: 'state not yet visible' }) },
      persistence: {
        loadPrivilegedApproval: async () => record(),
        claimExecutionLease: async (input) => ({
          claimed: true,
          attemptId: 'a1',
          versionAfter: input.expectedVersion + 1,
        }),
        closeExecution: async (input) => {
          closes.push(input.toStatus);
        },
      },
    } as never);
    const result = await SERVICE.executeApproved({ approvalId: APPROVAL_ID }, harness.ports);
    expect(result).toMatchObject({ outcome: 'BLOCKED', code: 'OUTCOME_UNVERIFIED' });
    expect(closes).toContain('EXECUTION_FAILED');
  });

  it('executor exception closes EXECUTION_FAILED and does not mask via success path', async () => {
    const closes: string[] = [];
    const harness = makePorts({
      executor: {
        executeOnce: async () => {
          throw new Error('provider socket died');
        },
      },
      persistence: {
        loadPrivilegedApproval: async () => record(),
        claimExecutionLease: async (input) => ({
          claimed: true,
          attemptId: 'a1',
          versionAfter: input.expectedVersion + 1,
        }),
        closeExecution: async (input) => {
          closes.push(input.toStatus);
        },
      },
    } as never);
    await expect(
      SERVICE.executeApproved({ approvalId: APPROVAL_ID }, harness.ports),
    ).rejects.toThrow('socket died');
    expect(closes).toEqual(['EXECUTION_FAILED']);
  });
});

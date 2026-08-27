/**
 * C033 §22 — staleness/expiry determinations, TTL boundaries with fake clock,
 * and state-transition CAS through the persistence port.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalValidityService, type ExpiringApprovalState } from '@devguard/approvals';

const NOW = 1_700_000_000_000;
const BOUND_ACTION = 'a'.repeat(64);
const BOUND_CONTEXT = 'b'.repeat(64);

function state(overrides: Partial<ExpiringApprovalState> = {}): ExpiringApprovalState {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'PENDING',
    version: 5,
    expiresAtMs: NOW + 60_000,
    boundActionFingerprint: BOUND_ACTION,
    boundContextFingerprint: BOUND_CONTEXT,
    boundCancellationGeneration: 2,
    supportedFingerprintSchemaVersion: true,
    ...overrides,
  };
}

function current(overrides = {}) {
  return {
    actionFingerprint: BOUND_ACTION,
    contextFingerprint: BOUND_CONTEXT,
    currentCancellationGeneration: 2,
    ...overrides,
  };
}

function makeService() {
  const checks: unknown[] = [];
  const transitions: Array<{ to: string; from: string }> = [];
  const service = new ApprovalValidityService(
    {
      loadExpiringApproval: async () => state(),
      appendValidityCheck: async (record) => {
        checks.push(record);
      },
      compareAndSet: async (input) => {
        transitions.push({ to: input.to, from: input.from });
        return { applied: true, versionAfter: input.expectedVersion + 1 };
      },
    },
    (() => {
      let n = 0;
      return () => `check-${++n}`;
    })(),
  );
  return { service, checks, transitions };
}

describe('validity determination (C033 §22)', () => {
  it('matching context within TTL is VALID', () => {
    const { service } = makeService();
    const outcome = service.determine(state(), current(), NOW);
    expect(outcome).toEqual({ result: 'VALID', reasonCodes: [] });
  });

  it('every authorization-relevant change yields STALE with its specific code', () => {
    const cases: Array<[string, ExpiringApprovalState, ReturnType<typeof current>, string[]]> = [
      [
        'action changed',
        state(),
        current({ actionFingerprint: 'c'.repeat(64) }),
        ['ACTION_CHANGED'],
      ],
      [
        'context digest changed',
        state(),
        current({ contextFingerprint: 'd'.repeat(64) }),
        ['TARGET_CHANGED'],
      ],
      [
        'workflow superseded',
        state(),
        current({ currentCancellationGeneration: 3 }),
        ['WORKFLOW_SUPERSEDED'],
      ],
      [
        'schema unsupported',
        state({ supportedFingerprintSchemaVersion: false }),
        current(),
        ['FINGERPRINT_SCHEMA_UNSUPPORTED'],
      ],
    ];
    for (const [name, s, c, expected] of cases) {
      const { service } = makeService();
      const outcome = service.determine(s, c, NOW);
      expect(outcome.result, name).toBe('STALE');
      expect([...outcome.reasonCodes].sort(), name).toEqual([...expected].sort());
    }
  });

  it('TIME_EXPIRED maps to EXPIRED, never STALE (boundary: at max age = expired)', () => {
    const { service } = makeService();
    const atExpiry = service.determine(state(), current(), NOW + 60_000);
    expect(atExpiry.result).toBe('EXPIRED');
    const afterExpiry = service.determine(state(), current(), NOW + 61_000);
    expect(afterExpiry.result).toBe('EXPIRED');
    const justBefore = service.determine(state(), current(), NOW + 59_999);
    expect(justBefore.result).toBe('VALID');
  });

  it('multiple simultaneous causes accumulate all codes', () => {
    const { service } = makeService();
    const outcome = service.determine(
      state(),
      current({ actionFingerprint: 'e'.repeat(64), currentCancellationGeneration: 9 }),
      NOW,
    );
    expect(outcome.reasonCodes).toContain('ACTION_CHANGED');
    expect(outcome.reasonCodes).toContain('WORKFLOW_SUPERSEDED');
  });

  it('check() appends evidence and CAS-transitions stale-capable states', async () => {
    const h = makeService();
    const result = await h.service.check({
      approvalId: 'x',
      purpose: 'EVENT',
      current: current({ actionFingerprint: 'f'.repeat(64) }),
      nowMs: NOW,
    });
    expect(result.kind).toBe('STALE');
    if (result.kind === 'STALE') {
      expect(result.reasonCodes).toContain('ACTION_CHANGED');
      expect(result.applied).toBe(true);
    }
    expect(h.checks).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({ from: 'PENDING', to: 'STALE' });
  });

  it('expired transitions land on EXPIRED with TIME_EXPIRED reason', async () => {
    const h = makeService();
    const result = await h.service.check({
      approvalId: 'x',
      purpose: 'SCHEDULED',
      current: current(),
      nowMs: NOW + 60_000,
    });
    expect(result.kind).toBe('EXPIRED');
    expect(h.transitions[0]).toMatchObject({ from: 'PENDING', to: 'EXPIRED' });
  });

  it('terminal approvals are INDETERMINATE_FAIL_CLOSED, not silently valid', async () => {
    const persist = {
      loadExpiringApproval: async () => state({ status: 'EXECUTED' as never }),
      appendValidityCheck: async () => undefined,
      compareAndSet: async () => ({ applied: true, versionAfter: 6 }),
    };
    const service = new ApprovalValidityService(persist, () => 'check-x');
    const result = await service.check({
      approvalId: 'x',
      purpose: 'RESOLUTION',
      current: current(),
      nowMs: NOW,
    });
    expect(result.kind).toBe('INDETERMINATE_FAIL_CLOSED');
  });

  it('expireDue expires only due PENDING/APPROVED candidates and counts applied CAS wins', async () => {
    const service = new ApprovalValidityService(
      {
        loadExpiringApproval: async () => state(),
        appendValidityCheck: async () => undefined,
        compareAndSet: async (input) =>
          input.approvalId === 'due-1'
            ? { applied: true, versionAfter: 6 }
            : { applied: false, versionAfter: 1 },
      },
      () => 'check',
    );
    const count = await service.expireDue({
      candidates: [
        { id: 'due-1', status: 'PENDING' as never, version: 5, expiresAtMs: NOW - 1000 },
        { id: 'not-due', status: 'PENDING' as never, version: 5, expiresAtMs: NOW + 1000 },
        { id: 'lost-race', status: 'APPROVED' as never, version: 5, expiresAtMs: NOW - 500 },
        { id: 'terminal-already', status: 'EXECUTED' as never, version: 5, expiresAtMs: NOW - 500 },
      ],
      nowMs: NOW,
    });
    expect(count).toBe(1);
  });
});

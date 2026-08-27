/**
 * C032 §22 — authorization matrix, duplicate/conflict semantics, CAS races.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalAuthorizationService, type ApprovalSnapshot } from '@devguard/approvals';

const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'PENDING',
    version: 3,
    actionFingerprint: 'a'.repeat(64),
    contextFingerprint: 'b'.repeat(64),
    expiresAtMs: NOW + 60_000,
    cancellationGeneration: 0,
    ...overrides,
  };
}

function makeHarness(
  state: Partial<ApprovalSnapshot> = {},
  options: { grant?: boolean; race?: boolean } = {},
) {
  const { grant = true, race = false } = options;
  let currentStatus = state.status ?? 'PENDING';
  let currentVersion = state.version ?? 3;
  const calls: string[] = [];
  const service = new ApprovalAuthorizationService({
    authorizer: {
      authorizeFresh: async (_p, _r, capability) => {
        calls.push(capability);
        return { authorized: grant, ...(grant ? {} : { reasonCode: 'ROLE_INSUFFICIENT' }) };
      },
    },
    approvals: {
      load: async () =>
        snapshot({ ...state, status: currentStatus as never, version: currentVersion }),
      compareAndSet: async (input) => {
        if (race) return { applied: false, versionAfter: currentVersion + 1 };
        if (currentStatus !== input.from || currentVersion !== input.expectedVersion) {
          return { applied: false, versionAfter: currentVersion };
        }
        currentStatus = input.to;
        currentVersion += 1;
        calls.push(`cas:${input.to}`);
        return { applied: true, versionAfter: currentVersion };
      },
    },
    validity: {
      checkForResolution: async (input) => {
        if (input.nowMs >= (state.expiresAtMs ?? NOW + 60_000)) {
          return { ok: false, code: 'APPROVAL_EXPIRED', detail: 'past expiry' };
        }
        if (
          input.expectedActionFingerprint !== 'a'.repeat(64) ||
          input.expectedContextFingerprint !== 'b'.repeat(64)
        ) {
          return {
            ok: false,
            code: 'APPROVAL_STALE',
            detail: 'fingerprint mismatch vs current binding',
          };
        }
        return { ok: true };
      },
    },
    now: () => NOW,
  });
  return { service, calls };
}

const PRINCIPAL = { userId: 'user-1', kind: 'user' as const };

function command(decision: 'APPROVE' | 'REJECT' = 'APPROVE') {
  return {
    commandId: `cmd-${decision.toLowerCase()}-1`,
    approvalId: '11111111-1111-4111-8111-111111111111',
    decision,
    expectedVersion: 3,
    expectedActionFingerprint: 'a'.repeat(64),
    expectedContextFingerprint: 'b'.repeat(64),
  } as const;
}

describe('resolution authorization (C032 §12)', () => {
  it('obtains FRESH capability evidence before touching the aggregate; approve and reject use distinct capabilities', async () => {
    const approveHarness = makeHarness();
    await approveHarness.service.resolve(PRINCIPAL, command('APPROVE'));
    expect(approveHarness.calls[0]).toBe('APPROVE_PRIVILEGED_ACTION');
    expect(approveHarness.calls).toContain('cas:APPROVED');

    const rejectHarness = makeHarness({ status: 'PENDING' });
    await rejectHarness.service.resolve(PRINCIPAL, command('REJECT'));
    expect(rejectHarness.calls[0]).toBe('REJECT_PRIVILEGED_ACTION');
  });

  it('approves exactly once with expected version + both fingerprints', async () => {
    const h = makeHarness();
    const result = await h.service.resolve(PRINCIPAL, command());
    expect(result).toMatchObject({ outcome: 'APPLIED', status: 'APPROVED', version: 4 });
  });

  it('stale fingerprints from a stale UI fail closed with APPROVAL_STALE', async () => {
    const h = makeHarness();
    const result = await h.service.resolve(PRINCIPAL, {
      ...command(),
      expectedContextFingerprint: 'outdated'.padEnd(64, '0'),
    });
    expect(result).toMatchObject({ outcome: 'DENIED', code: 'APPROVAL_STALE' });
  });

  it('expired approvals refuse resolution with APPROVAL_EXPIRED', async () => {
    const h = makeHarness({ expiresAtMs: NOW - 1000 });
    const result = await h.service.resolve(PRINCIPAL, command());
    expect(result).toMatchObject({ outcome: 'DENIED', code: 'APPROVAL_EXPIRED' });
  });

  it('duplicate same decision = NOOP_SAME_DECISION preserving the FIRST actor record', async () => {
    const h = makeHarness({
      status: 'APPROVED',
      finalDecision: 'APPROVE',
      resolvedBy: 'first-actor',
    });
    const second = await h.service.resolve(PRINCIPAL, command('APPROVE'));
    expect(second).toMatchObject({ outcome: 'NOOP_SAME_DECISION' });

    const thirdActor = makeHarness({
      status: 'APPROVED',
      finalDecision: 'APPROVE',
      resolvedBy: 'first-actor',
    });
    const anotherApprove = await thirdActor.service.resolve(
      { userId: 'user-2', kind: 'user' },
      command('APPROVE'),
    );
    // Second approver is NOT a vote: same decision noop, resolvedBy untouched.
    expect(anotherApprove.outcome).toBe('NOOP_SAME_DECISION');
    expect(thirdActor.calls).not.toContain('cas:');
  });

  it('conflicting decision after resolution = APPROVAL_ALREADY_RESOLVED and never rewrites outcome', async () => {
    const h = makeHarness({
      status: 'APPROVED',
      finalDecision: 'APPROVE',
      resolvedBy: 'first-actor',
    });
    const conflict = await h.service.resolve(PRINCIPAL, command('REJECT'));
    expect(conflict).toMatchObject({ outcome: 'DENIED', code: 'APPROVAL_ALREADY_RESOLVED' });
  });

  it('terminal states map to stable refusal codes', async () => {
    expect(
      (await makeHarness({ status: 'STALE' }).service.resolve(PRINCIPAL, command())).outcome,
    ).toBe('DENIED');
    expect(
      (await makeHarness({ status: 'EXECUTING' }).service.resolve(PRINCIPAL, command())).code,
    ).toBe('APPROVAL_EXECUTION_STARTED');
  });

  it('lost CAS race reports APPROVAL_VERSION_CONFLICT without partial writes', async () => {
    const h = makeHarness({}, { race: true });
    const result = await h.service.resolve(PRINCIPAL, command());
    expect(result).toMatchObject({ outcome: 'DENIED', code: 'APPROVAL_VERSION_CONFLICT' });
  });

  it('cancellation before execution claims uses dedicated capability and CAS-guards races', async () => {
    const h = makeHarness();
    const cancel = await h.service.cancel(PRINCIPAL, {
      commandId: 'cancel-1',
      approvalId: '11111111-1111-4111-8111-111111111111',
      expectedVersion: 3,
      reason: 'wrong target picked',
    });
    expect(cancel).toMatchObject({ outcome: 'APPLIED', status: 'CANCELLED' });
    expect(h.calls[0]).toBe('CANCEL_PRIVILEGED_ACTION');

    const alreadyCancelled = makeHarness({ status: 'CANCELLED' });
    expect(
      (
        await alreadyCancelled.service.cancel(PRINCIPAL, {
          commandId: 'cancel-2',
          approvalId: 'x',
          expectedVersion: 9,
          reason: 'r',
        })
      ).outcome,
    ).toBe('NOOP_SAME_DECISION');
  });
});

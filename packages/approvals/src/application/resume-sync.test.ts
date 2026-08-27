/**
 * C035 §22 — intent mapping totals, idempotent intent creation, no-split-brain
 * resume gating, closure safety on duplicates.
 */
import { describe, expect, it } from 'vitest';
import {
  ApprovalResumeCoordinator,
  RESUME_INTENT_KINDS,
  intentForStatus,
  type RuntimeLink,
} from '@devguard/approvals';

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';

function link(): RuntimeLink {
  return {
    linkId: 'link-1',
    approvalId: APPROVAL_ID,
    provider: 'trueforge',
    checkpointTokenDigest: 'digest-1',
    sessionId: 'sess-1',
    turnId: 'turn-9',
    observedSequence: 3,
    syncState: 'PENDING',
  };
}

describe('intent mapping totality (C035 §5.2)', () => {
  it('every terminal/approved status maps to exactly one intent; PENDING/EXECUTING do not', () => {
    expect(intentForStatus('APPROVED')).toBe('CONTINUE_APPROVED');
    expect(intentForStatus('REJECTED')).toBe('CLOSE_REJECTED');
    expect(intentForStatus('STALE')).toBe('CLOSE_STALE');
    expect(intentForStatus('EXPIRED')).toBe('CLOSE_EXPIRED');
    expect(intentForStatus('CANCELLED')).toBe('CLOSE_CANCELLED');
    expect(intentForStatus('EXECUTED')).toBe('REPORT_EXECUTION_RESULT');
    expect(intentForStatus('EXECUTION_FAILED')).toBe('REPORT_EXECUTION_RESULT');
    expect(intentForStatus('PENDING')).toBeUndefined();
    expect(intentForStatus('EXECUTING')).toBeUndefined();
    void RESUME_INTENT_KINDS;
  });
});

function makeCoordinator() {
  const createdIntents: string[] = [];
  const deliveries: string[] = [];
  const resumes: string[] = [];
  const coordinator = new ApprovalResumeCoordinator({
    loadLink: async () => link(),
    createOrGetIntent: async ({ kind }) => {
      const key = `${APPROVAL_ID}:${kind}`;
      const alreadyExisted = createdIntents.includes(key);
      if (!alreadyExisted) createdIntents.push(key);
      return { intentId: `intent-${createdIntents.length}`, alreadyExisted };
    },
    transitionIntent: async () => ({ applied: true }),
    resumeCheckpoint: async (input) => {
      resumes.push(input.sessionId);
      return { resumed: true };
    },
    deliverClosure: async (input) => {
      deliveries.push(input.reasonCode);
    },
  });
  return { coordinator, createdIntents, deliveries, resumes };
}

function baseInput(status: 'REJECTED' | 'APPROVED' = 'REJECTED') {
  return {
    approvalId: APPROVAL_ID,
    status,
    version: 5,
    operationKey: 'opkey:pull_request.merge:42',
    cancellationGeneration: 2,
  } as const;
}

describe('closure intents', () => {
  it('rejection closes the runtime waiting state via CLOSE_REJECTED', async () => {
    const h = makeCoordinator();
    const result = await h.coordinator.onApprovalStateChanged(baseInput('REJECTED'));
    expect(result).toMatchObject({ kind: 'CLOSE_REJECTED', state: 'COMPLETED' });
    expect(h.deliveries).toEqual(['CLOSE_REJECTED']);
    expect(h.resumes).toEqual([]); // closures never resume
  });

  it('duplicate delivery is safe: replays converge without extra side effects failing', async () => {
    const h = makeCoordinator();
    await h.coordinator.onApprovalStateChanged(baseInput('REJECTED'));
    // Same message redelivered (at-least-once queue): idempotent replay.
    const replay = await h.coordinator.onApprovalStateChanged(baseInput('REJECTED'));
    expect(replay.state).toBe('COMPLETED');
    expect(h.deliveries).toEqual(['CLOSE_REJECTED', 'CLOSE_REJECTED']); // delivery is idempotent-safe to repeat
    expect(h.createdIntents).toHaveLength(1); // but only ONE durable intent
  });

  it.each(['EXPIRED', 'CANCELLED', 'STALE'] as const)(
    '%s closes with its dedicated code',
    async (status) => {
      const h = makeCoordinator();
      const result = await h.coordinator.onApprovalStateChanged({
        ...baseInput('REJECTED'),
        status,
      });
      expect(result.kind).toBe(`CLOSE_${status}`);
    },
  );
});

describe('CONTINUE_APPROVED gating (no split-brain)', () => {
  it('refuses to resume the turn WITHOUT durable execution evidence', async () => {
    const h = makeCoordinator();
    const result = h.coordinator.onApprovalStateChanged({
      ...baseInput('APPROVED'),
      executionEvidenceDigest: undefined,
    });
    await expect(result).rejects.toThrow(/without durable execution evidence/);
    expect(h.resumes).toEqual([]); // runtime never resumed
  });

  it('resumes only AFTER C034 evidence exists, carrying its digest', async () => {
    const seenDigests: string[] = [];
    const { coordinator } = makeCoordinatorWithResumeCapture(seenDigests);
    const result = await coordinator.onApprovalStateChanged({
      ...baseInput('APPROVED'),
      executionEvidenceDigest: 'evidence-digest-1',
    });
    expect(result.state).toBe('COMPLETED');
    expect(seenDigests).toEqual(['evidence-digest-1']);
  });

  function makeCoordinatorWithResumeCapture(seen: string[]) {
    return {
      coordinator: new ApprovalResumeCoordinator({
        loadLink: async () => link(),
        createOrGetIntent: async () => ({ intentId: 'i1', alreadyExisted: false }),
        transitionIntent: async () => ({ applied: true }),
        resumeCheckpoint: async (input) => {
          seen.push(input.executionEvidenceDigest ?? '');
          return { resumed: true };
        },
        deliverClosure: async () => undefined,
      }),
    };
  }

  it('missing runtime link fails loudly instead of silently dropping the decision', async () => {
    const orphan = new ApprovalResumeCoordinator({
      loadLink: async () => undefined,
      createOrGetIntent: async () => ({ intentId: 'i', alreadyExisted: false }),
      transitionIntent: async () => ({ applied: true }),
      resumeCheckpoint: async () => ({ resumed: true }),
      deliverClosure: async () => undefined,
    });
    await expect(orphan.onApprovalStateChanged({ ...baseInput('REJECTED') })).rejects.toThrow(
      /no runtime link/,
    );
  });

  it('runtime refusing the resume lands in RECONCILING, never COMPLETED', async () => {
    const coordinator = new ApprovalResumeCoordinator({
      loadLink: async () => link(),
      createOrGetIntent: async () => ({ intentId: 'i1', alreadyExisted: false }),
      transitionIntent: async () => ({ applied: true }),
      resumeCheckpoint: async () => ({ resumed: false, detail: 'session already torn down' }),
      deliverClosure: async () => undefined,
    });
    const result = await coordinator.onApprovalStateChanged({
      ...baseInput('APPROVED'),
      executionEvidenceDigest: 'dig',
    });
    expect(result.state).toBe('RECONCILING');
  });
});

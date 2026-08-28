import { describe, expect, it } from 'vitest';
import { ApprovalResumeService, InMemoryApprovalStore } from './approval-resume.js';
import type { ApprovalRecord } from './approval-resume.js';

const APPROVED: ApprovalRecord = {
  approvalId: 'appr-1',
  resolution: 'approved',
  resolutionVersion: 2,
  resolutionFingerprint: 'fp',
  runId: 'run-1',
  runState: 'WAITING_APPROVAL',
  executionGeneration: 1,
  cancelledVersion: 0,
};

describe('C059 approval resume', () => {
  it('resumes an approved, version-matched, nonterminal run exactly once', async () => {
    const store = new InMemoryApprovalStore();
    store.approvals.set('appr-1', APPROVED);
    let calls = 0;
    const svc = new ApprovalResumeService({
      store,
      executor: {
        execute: async (runId, approvalId) => {
          void runId;
          void approvalId;
          calls += 1;
          return { ok: true };
        },
      },
    });
    const first = await svc.resume('appr-1', 2);
    expect(first.state).toBe('COMPLETED');
    const replay = await svc.resume('appr-1', 2);
    expect(replay.state).toBe('COMPLETED');
    expect(calls).toBe(1); // idempotent by (approvalId, resolutionVersion)
  });

  it('never resumes a rejected or stale approval', async () => {
    const store = new InMemoryApprovalStore();
    store.approvals.set('appr-2', { ...APPROVED, approvalId: 'appr-2', resolution: 'rejected' });
    const svc = new ApprovalResumeService({
      store,
      executor: {
        execute: async () => {
          throw new Error('should not execute');
        },
      },
    });
    const out = await svc.resume('appr-2', 2);
    expect(out.state).toBe('STALE_NOOP');
  });

  it('fences on mismatched resolution version and cancelled run', async () => {
    const store = new InMemoryApprovalStore();
    store.approvals.set('appr-1', APPROVED);
    const svc = new ApprovalResumeService({
      store,
      executor: { execute: async () => ({ ok: true }) },
    });
    expect((await svc.resume('appr-1', 999)).state).toBe('STALE_NOOP');
    store.approvals.set('appr-3', { ...APPROVED, approvalId: 'appr-3', cancelledVersion: 5 });
    expect((await svc.resume('appr-3', 2)).state).toBe('CANCELLED_FENCED');
  });

  it('marks stale approvals expired without resuming', async () => {
    const store = new InMemoryApprovalStore();
    store.approvals.set('appr-1', APPROVED);
    const svc = new ApprovalResumeService({
      store,
      executor: { execute: async () => ({ ok: true }) },
    });
    await svc.expire('appr-1');
    expect(store.expired.has('appr-1')).toBe(true);
  });
});

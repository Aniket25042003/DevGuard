import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { registerSessionRoutes, type SessionPort } from './session.routes.js';
import { registerApprovalRoutes, type ApprovalPort } from './approval.routes.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async ({ sessionToken, bearerToken }) => {
      const token = bearerToken ?? sessionToken;
      return token === 'session-1'
        ? {
            status: 'authenticated',
            principal: {
              userId: 'user-1',
              issuer: 'github',
              providerSubject: 'octo',
              authMethod: 'session',
            } as never,
          }
        : { status: 'anonymous' };
    },
  });
}

class InMemorySessions implements SessionPort {
  readonly rows = new Map<
    string,
    { sessionId: string; state: string; turnCount: number; userId: string }
  >();
  constructor() {
    this.rows.set('sess-1', {
      sessionId: 'sess-1',
      state: 'READY',
      turnCount: 2,
      userId: 'user-1',
    });
  }
  async get(sessionId: string, userId: string) {
    const s = this.rows.get(sessionId);
    return s !== undefined && s.userId === userId
      ? { sessionId, state: s.state, turnCount: s.turnCount }
      : undefined;
  }
  async events(sessionId: string, userId: string, limit: number) {
    void userId;
    void limit;
    return sessionId === 'sess-1'
      ? [{ sequenceNumber: 1, eventType: 'turn.completed', summary: 'ok' }]
      : [];
  }
}

class InMemoryApprovals implements ApprovalPort {
  readonly rows = new Map<string, { approvalId: string; state: string; resolvedBy: string }>();
  constructor() {
    this.rows.set('appr-1', { approvalId: 'appr-1', state: 'PENDING', resolvedBy: '' });
  }
  async listFor(runId: string) {
    void runId;
    return [...this.rows.values()].map((a) => ({ approvalId: a.approvalId, state: a.state }));
  }
  async resolve(
    runId: string,
    approvalId: string,
    resolution: 'approved' | 'rejected',
    userId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    void runId;
    const a = this.rows.get(approvalId);
    if (a === undefined) return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'not found' };
    this.rows.set(approvalId, {
      ...a,
      state: resolution === 'approved' ? 'APPROVED' : 'REJECTED',
      resolvedBy: userId,
    });
    return { ok: true };
  }
}

describe('C068 session routes', () => {
  it('serves a per-principal session status and 404s unknown/other-user sessions', async () => {
    const k = kernel();
    registerSessionRoutes(k, new InMemorySessions());
    const headers = { cookie: 'devguard_session=session-1' };
    const ok = await k.app.request('/api/v1/sessions/sess-1', { headers });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: 'READY', turnCount: 2 });
    expect((await k.app.request('/api/v1/sessions/nope', { headers })).status).toBe(404);
    const events = await k.app.request('/api/v1/sessions/sess-1/events', { headers });
    expect(events.status).toBe(200);
    expect(((await events.json()) as { events: unknown[] }).events.length).toBe(1);
  });
});

describe('C070 approval routes', () => {
  it('lists approvals and resolves approve/reject (persisted before effect)', async () => {
    const k = kernel();
    const approvals = new InMemoryApprovals();
    registerApprovalRoutes(k, approvals);
    const headers = { cookie: 'devguard_session=session-1', 'content-type': 'application/json' };
    const list = await k.app.request('/api/v1/workflows/run-1/approvals', { headers });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { approvals: Array<{ approvalId: string; state: string }> })
        .approvals,
    ).toEqual([{ approvalId: 'appr-1', state: 'PENDING' }]);
    const approve = await k.app.request('/api/v1/workflows/run-1/approvals/appr-1', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(approve.status).toBe(200);
    expect(approvals.rows.get('appr-1')?.state).toBe('APPROVED');
    const badAction = await k.app.request('/api/v1/workflows/run-1/approvals/appr-1', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'maybe' }),
    });
    expect(badAction.status).toBe(400);
  });
});

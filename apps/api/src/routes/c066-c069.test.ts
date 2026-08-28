import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import {
  registerPolicyRoutes,
  registerWorkflowRoutes,
  registerCommandRoutes,
  type PolicySummaryPort,
  type WorkflowLaunchPort,
  type WorkflowStatusPort,
  type CommandCatalogPort,
} from './workflow.routes.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async (token: string | undefined) =>
      token === 'session-1'
        ? ({ userId: 'user-1', issuer: 'github', providerSubject: 'octo' } as never)
        : undefined,
  });
}

class InMemoryWorkflows implements WorkflowLaunchPort, WorkflowStatusPort, CommandCatalogPort {
  readonly runs = new Map<
    string,
    { runId: string; userId: string; state: string; idempotencyKey: string }
  >();
  private counter = 0;
  async launch(
    input: { workflowType: string; version: string; idempotencyKey: string; input: unknown },
    userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  > {
    const existing = [...this.runs.values()].find(
      (r) => r.userId === userId && r.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return { ok: true, runId: existing.runId, replayed: true };
    this.counter += 1;
    const runId = `run-${this.counter}`;
    this.runs.set(runId, { runId, userId, state: 'QUEUED', idempotencyKey: input.idempotencyKey });
    return { ok: true, runId, replayed: false };
  }
  async statusOf(
    runId: string,
    userId: string,
  ): Promise<{ runId: string; state: string } | undefined> {
    const run = this.runs.get(runId);
    return run !== undefined && run.userId === userId ? { runId, state: run.state } : undefined;
  }
  async commandsOf(
    runId: string,
  ): Promise<
    Array<{ commandId: string; class: string; state: string; argvRedacted: readonly string[] }>
  > {
    void runId;
    return [];
  }
}

describe('C066 policy route', () => {
  it('returns a safe summary only for an authenticated session', async () => {
    const k = kernel();
    const policies: PolicySummaryPort = {
      async summaryFor(_userId: string) {
        return [{ id: 'pol-1', name: 'default', enabled: true }];
      },
    };
    registerPolicyRoutes(k, policies);
    expect((await k.app.request('/api/v1/policies')).status).toBe(401);
    const res = await k.app.request('/api/v1/policies', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policies: [{ id: 'pol-1', name: 'default', enabled: true }],
    });
  });
});

describe('C067 workflow routes', () => {
  it('launches idempotently by idempotencyKey and projects status', async () => {
    const k = kernel();
    const svc = new InMemoryWorkflows();
    registerWorkflowRoutes(k, svc, svc);
    const headers = { cookie: 'devguard_session=session-1', 'content-type': 'application/json' };
    const launch = await k.app.request('/api/v1/workflows', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowType: 'implement_issue',
        version: '1.0.0',
        idempotencyKey: 'k1',
        input: {},
      }),
    });
    expect(launch.status).toBe(202);
    const launchBody = (await launch.json()) as { runId: string };
    const status = await k.app.request(`/api/v1/workflows/${launchBody.runId}`, {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: 'QUEUED' });
    const replay = await k.app.request('/api/v1/workflows', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowType: 'implement_issue',
        version: '1.0.0',
        idempotencyKey: 'k1',
        input: {},
      }),
    });
    expect(replay.status).toBe(200); // replayed
    expect(((await replay.json()) as { runId: string }).runId).toBe(launchBody.runId);
  });

  it('404s an unknown/other-user run and 400s a malformed launch body', async () => {
    const k = kernel();
    const svc = new InMemoryWorkflows();
    registerWorkflowRoutes(k, svc, svc);
    const headers = { cookie: 'devguard_session=session-1' };
    expect((await k.app.request('/api/v1/workflows/nope', { headers })).status).toBe(404);
    const bad = await k.app.request('/api/v1/workflows', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('C069 command route', () => {
  it('returns the (currently empty) command catalog for a run', async () => {
    const k = kernel();
    const svc = new InMemoryWorkflows();
    registerCommandRoutes(k, svc);
    const res = await k.app.request('/api/v1/workflows/run-1/commands', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [] });
  });
});

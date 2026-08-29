import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import {
  registerPolicyRoutes,
  registerWorkflowRoutes,
  registerCommandRoutes,
  type CommandCatalogPort,
  type PolicySummaryPort,
} from './workflow.routes.js';
import {
  CommandBus,
  WorkflowQueryService,
  type RunRow,
  type WorkflowRunStorePort,
} from '@devguard/workflows';

const REPO = '11111111-2222-4333-8444-555555555555';
const RUN = 'c8a2e9f0-1111-4222-8333-444455556666';

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
    // CP005: repo-scoped routes in tests all pass authorization.
    authorize: async () => {},
  });
}

class InMemoryRunStore implements WorkflowRunStorePort {
  private readonly rows = new Map<string, RunRow>();
  seed(run: RunRow): void {
    this.rows.set(run.id, run);
  }
  async getDetail(id: string): Promise<RunRow | null> {
    return this.rows.get(id) ?? null;
  }
  async list(options: {
    repositoryId: string;
    limit: number;
    cursor?: { createdAtIso: string; id: string } | undefined;
  }): Promise<RunRow[]> {
    let rows = [...this.rows.values()].filter((r) => r.repositoryId === options.repositoryId);
    rows.sort((a, b) => (a.createdAtIso > b.createdAtIso ? -1 : 1));
    if (options.cursor !== undefined) {
      rows = rows.filter(
        (r) => r.createdAtIso < options.cursor!.createdAtIso || r.id < options.cursor!.id,
      );
    }
    return rows.slice(0, options.limit + 1);
  }
  async cancel(id: string, expectedVersion: number): Promise<RunRow> {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.rowVersion !== expectedVersion ||
      (row.status !== 'queued' && row.status !== 'waiting_for_approval')
    ) {
      throw new Error('CANCEL_CONFLICT');
    }
    const updated: RunRow = {
      ...row,
      status: 'cancelled',
      rowVersion: row.rowVersion + 1,
      completedAtIso: row.completedAtIso,
    };
    this.rows.set(id, updated);
    return updated;
  }
}

class InMemoryCommandPersistence {
  async createQueuedRun(input: {
    idempotencyKeyHash: string;
    runId: string;
  }): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  > {
    const existing = this.hash.get(input.idempotencyKeyHash);
    if (existing !== undefined) return { outcome: 'replayed', runId: existing };
    this.hash.set(input.idempotencyKeyHash, input.runId);
    return { outcome: 'created', runId: input.runId };
  }
  private readonly hash = new Map<string, string>();
}

function queuedRow(status = 'queued'): RunRow {
  return {
    id: RUN,
    repositoryId: REPO,
    workflowType: 'review_remediation',
    status,
    triggerType: 'manual',
    originSurface: 'cli',
    definitionVersion: '1',
    createdAtIso: '2026-01-01T00:00:00.000Z',
    updatedAtIso: '2026-01-01T00:00:00.000Z',
    rowVersion: 1,
  };
}

function container(store: InMemoryRunStore) {
  const workflowQueries = new WorkflowQueryService({ runs: store });
  const commandBus = new CommandBus({
    persistence: new InMemoryCommandPersistence() as never,
    newRunId: () => 'c8a2e9f0-1111-4222-8333-444455556666',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  const authorizer = {
    authorize: async () => ({ effect: 'allow' as const, reasonCode: 'ok' }),
  };
  const bindings = {
    policies: { summaryFor: async () => [] },
  } as never;
  return { workflowQueries, commandBus, authorizer, bindings };
}

function startBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    commandId: 'review',
    definitionVersion: '1.0.0',
    input: {},
    originSurface: 'cli',
    ...overrides,
  });
}

describe('C066 policy route', () => {
  it('returns a safe summary only for an authenticated session', async () => {
    const k = kernel();
    const policies: PolicySummaryPort = {
      summaryFor: async () => [{ id: 'pol-1', name: 'default', enabled: true }],
    };
    const shim = { bindings: { policies } } as never;
    registerPolicyRoutes(k, shim);
    const res = await k.app.request('/api/v1/policies', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policies: [{ id: 'pol-1', name: 'default', enabled: true }],
    });
  });
});

describe('C067 workflow routes (durable)', () => {
  it('starts a workflow via the repo-scoped POST and returns a receipt (202)', async () => {
    const k = kernel();
    const store = new InMemoryRunStore();
    registerWorkflowRoutes(k, container(store) as never);
    const headers = {
      cookie: 'devguard_session=session-1',
      'content-type': 'application/json',
      'idempotency-key': 'idempotency-command-0001',
    };
    const start = await k.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
      headers,
      body: startBody(),
    });
    expect(start.status).toBe(202);
    const body = (await start.json()) as { data: { status: string; workflowRunId: string } };
    expect(body.data.status).toBe('accepted');
    expect(body.data.workflowRunId).toBe('c8a2e9f0-1111-4222-8333-444455556666');
  });

  it('lists durable runs with keyset pagination', async () => {
    const k = kernel();
    const store = new InMemoryRunStore();
    store.seed(queuedRow('queued'));
    registerWorkflowRoutes(k, container(store) as never);
    const res = await k.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { runs: Array<{ id: string; status: string }>; hasMore: boolean };
    };
    expect(body.data.runs.length).toBe(1);
    expect(body.data.runs[0]?.id).toBe(RUN);
    expect(body.data.runs[0]?.status).toBe('queued');
    expect(body.data.hasMore).toBe(false);
  });

  it('gets a durable run and cancels a queued one via If-Match', async () => {
    const k = kernel();
    const store = new InMemoryRunStore();
    store.seed(queuedRow('queued'));
    registerWorkflowRoutes(k, container(store) as never);
    const headers = { cookie: 'devguard_session=session-1' };

    const get = await k.app.request(`/api/v1/workflows/${RUN}`, { headers });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { data: { status: string } }).data.status).toBe('queued');

    const cancel = await k.app.request(`/api/v1/workflows/${RUN}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'if-match': '1' },
    });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { data: { status: string } }).data.status).toBe('cancelled');
  });

  it('returns 404 for an unknown/unauthorized run and 428 without If-Match', async () => {
    const k = kernel();
    const store = new InMemoryRunStore();
    registerWorkflowRoutes(k, container(store) as never);
    const headers = { cookie: 'devguard_session=session-1' };
    expect((await k.app.request('/api/v1/workflows/nonexistent', { headers })).status).toBe(404);
    const cancel = await k.app.request(`/api/v1/workflows/${RUN}/cancel`, {
      method: 'POST',
      headers,
    });
    expect(cancel.status).toBe(428);
  });
});

describe('C069 command route', () => {
  it('returns the (currently empty) command catalog for a run', async () => {
    const k = kernel();
    const svc: CommandCatalogPort = { commandsOf: async () => [] };
    registerCommandRoutes(k, svc);
    const res = await k.app.request('/api/v1/workflows/run-1/commands', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [] });
  });
});

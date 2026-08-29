/** CP018 — thin web-surface aliases. */
import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { registerWebSurfaceRoutes } from './web-surface.routes.js';
import type { ApprovalPort } from './approval.routes.js';
import type { ApiContainer } from '../composition/container.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async ({ sessionToken }) =>
      sessionToken !== undefined
        ? {
            status: 'authenticated',
            principal: {
              userId: 'u-1',
              issuer: 'github',
              providerSubject: 'octo',
              authMethod: 'session',
            } as never,
          }
        : { status: 'anonymous' },
    authorize: async () => {},
  });
}

const approvals: ApprovalPort = {
  async listFor() {
    return [];
  },
  async resolve() {
    return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'no approval store wired' };
  },
};

function register(k: ReturnType<typeof kernel>): void {
  registerWebSurfaceRoutes(k, { pool: undefined } as unknown as ApiContainer, approvals);
}

const cookie = { headers: { cookie: 'devguard_session=s1' } };

describe('CP018 web-surface aliases', () => {
  it('lists GitHub installations as an honest empty catalog without a store', async () => {
    const k = kernel();
    register(k);
    const res = await k.app.request('/api/v1/github/installations', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installations: [] });
  });

  it('returns a GitHub-managed install URL instead of a Next OAuth workaround', async () => {
    const k = kernel();
    register(k);
    const res = await k.app.request('/api/v1/github/installations/intents', {
      method: 'POST',
      headers: { cookie: 'devguard_session=s1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { installUrl: string };
    expect(body.installUrl).toMatch(/^https:\/\/github\.com\//);
  });

  it('returns policy defaults when no version is stored', async () => {
    const k = kernel();
    register(k);
    const res = await k.app.request(
      '/api/v1/repositories/11111111-2222-4333-8444-555555555555/policy',
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      document: { autonomy: { level: string } };
    };
    expect(body.source).toBe('defaults');
    expect(body.document.autonomy.level).toBe('assist');
  });

  it('lists top-level approvals through the shared port', async () => {
    const k = kernel();
    register(k);
    const res = await k.app.request('/api/v1/approvals', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [] });
  });

  it('refuses repository connect when the durable store is unbound', async () => {
    const k = kernel();
    register(k);
    const res = await k.app.request('/api/v1/repositories', {
      method: 'POST',
      headers: {
        cookie: 'devguard_session=s1',
        'content-type': 'application/json',
        'idempotency-key': 'a'.repeat(32),
      },
      body: JSON.stringify({
        installationId: '1',
        githubRepositoryId: '2',
        owner: 'acme',
        name: 'api',
      }),
    });
    expect(res.status).toBe(503);
  });
});

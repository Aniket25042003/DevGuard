import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { registerHealthRoutes } from './health.routes.js';
import {
  registerRepositoryRoutes,
  registerWebhookRoutes,
  verifyGithubHmac,
  type RepositoryCatalogPort,
  type WebhookAcceptancePort,
} from './github.routes.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async (token: string | undefined) =>
      token === 'session-1'
        ? ({
            userId: 'user-1',
            issuer: 'github',
            providerSubject: 'octo',
            providerLogin: 'octo',
          } as never)
        : undefined,
    webhookMaxBodyBytes: 1_048_576,
  });
}

describe('C074 health routes', () => {
  it('liveness returns ok and readiness depends on critical probes', async () => {
    const k = kernel();
    registerHealthRoutes(k, [{ name: 'db', critical: true, check: async () => ({ ok: false }) }]);
    const live = await k.app.request('/api/v1/health/live');
    expect(live.status).toBe(200);
    const ready = await k.app.request('/api/v1/health/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, level: 'unhealthy' });
  });
});

describe('C075 GitHub webhook route', () => {
  it('verifies HMAC over the raw body before acceptance', async () => {
    const k = kernel();
    const accepted: WebhookAcceptancePort = { accept: async () => ({ accepted: true }) };
    registerWebhookRoutes(k, accepted, () => 'topsecret', verifyGithubHmac);
    const body = JSON.stringify({ action: 'opened' });
    const sig = `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`;
    const okRes = await k.app.request('/api/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'dlv-1',
        'x-hub-signature-256': sig,
        'content-type': 'application/json',
      },
      body,
    });
    expect(okRes.status).toBe(202);
    const badRes = await k.app.request('/api/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=bad',
        'content-type': 'application/json',
      },
      body,
    });
    expect(badRes.status).toBe(401);
  });
});

describe('C065 repository catalog route', () => {
  const emptyCatalog: RepositoryCatalogPort = {
    async listFor(_userId: string) {
      return [];
    },
  };
  const catalog: RepositoryCatalogPort = {
    async listFor(userId: string) {
      return userId === 'user-1' ? [{ id: 'repo-1', name: 'demo', role: 'admin' }] : [];
    },
  };

  it('requires a session and is safely truthfully empty when not wired', async () => {
    const k = kernel();
    registerRepositoryRoutes(k, emptyCatalog);
    const unauth = await k.app.request('/api/v1/repositories');
    expect(unauth.status).toBe(401);
    const authed = await k.app.request('/api/v1/repositories', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ repositories: [] });
  });

  it('projects the authorized catalog for the principal', async () => {
    const k = kernel();
    registerRepositoryRoutes(k, catalog);
    const res = await k.app.request('/api/v1/repositories', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(await res.json()).toEqual({
      repositories: [{ id: 'repo-1', name: 'demo', role: 'admin' }],
    });
  });
});

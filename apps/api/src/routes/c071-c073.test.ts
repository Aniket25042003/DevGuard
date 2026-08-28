import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { registerArtifactRoutes, type ArtifactPort } from './artifact.routes.js';
import { registerAuditRoutes, type AuditPort } from './audit.routes.js';
import { registerFindingsRoutes, type FindingsPort } from './findings.routes.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async (token: string | undefined) =>
      token === 'session-1'
        ? ({ userId: 'user-1', issuer: 'github', providerSubject: 'octo' } as never)
        : undefined,
  });
}

describe('C071 artifact routes', () => {
  it('lists and serves only SAFE artifacts', async () => {
    const k = kernel();
    const safe = { id: 'art-1', scanState: 'SAFE' as const };
    const artifacts: ArtifactPort = {
      async listFor(runId: string) {
        void runId;
        return [safe];
      },
      async getSafe(id: string) {
        return id === 'art-1' ? safe : undefined;
      },
    };
    registerArtifactRoutes(k, artifacts);
    const headers = { cookie: 'devguard_session=session-1' };
    const list = await k.app.request('/api/v1/workflows/run-1/artifacts', { headers });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { artifacts: unknown[] }).artifacts).toEqual([safe]);
    expect((await k.app.request('/api/v1/artifacts/art-1', { headers })).status).toBe(200);
    expect((await k.app.request('/api/v1/artifacts/quarantined', { headers })).status).toBe(404);
  });
});

describe('C072 audit route', () => {
  it('serves an integrity-verified audit log and 500s on mismatch', async () => {
    const k = kernel();
    const headers = { cookie: 'devguard_session=session-1' };
    const good: AuditPort = {
      async list(_userId: string) {
        return {
          verified: true,
          rows: [{ id: 'aud-1', occurredAtIso: 'ts', changeKind: 'privileged', summary: 'merge' }],
        };
      },
    };
    registerAuditRoutes(k, good);
    expect((await k.app.request('/api/v1/audit', { headers })).status).toBe(200);
    const bad: AuditPort = {
      async list(_userId: string) {
        return { verified: false, rows: [] };
      },
    };
    const k2 = kernel();
    registerAuditRoutes(k2, bad);
    expect((await k2.app.request('/api/v1/audit', { headers })).status).toBe(500);
  });
});

describe('C073 security findings route', () => {
  it('returns normalized findings', async () => {
    const k = kernel();
    const findings: FindingsPort = {
      async listFor(_runId: string) {
        return [{ id: 'f-1', severity: 'high', status: 'open' }];
      },
    };
    registerFindingsRoutes(k, findings);
    const res = await k.app.request('/api/v1/workflows/run-1/security-findings', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { findings: unknown[] }).findings).toEqual([
      { id: 'f-1', severity: 'high', status: 'open' },
    ]);
  });
});

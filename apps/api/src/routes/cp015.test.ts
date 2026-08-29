/** CP015 — diagnostics preflight + runs summary + finding remediation. */
import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import {
  registerDiagnosticsRoutes,
  type PreflightStatus,
  type RunsSummaryPort,
} from './diagnostics.routes.js';
import {
  registerFindingsRemediationRoutes,
  type RemediationSubmitPort,
} from './findings.routes.js';

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

const preflight: PreflightStatus = {
  database: true,
  redis: true,
  trueforge: false,
  sandbox: false,
  github: true,
};
const makeRuns: RunsSummaryPort = async ({ repositoryId }) => ({
  runs: [
    {
      id: 'r1',
      repositoryId,
      workflowType: 'review_remediation',
      status: 'queued',
      createdAtIso: '2026-01-01T00:00:00.000Z',
      updatedAtIso: '2026-01-01T00:00:00.000Z',
      definitionVersion: 1,
      triggerType: 'manual',
      originSurface: 'web',
      rowVersion: 1,
    },
  ],
  hasMore: false,
});

describe('CP015 diagnostics + remediation', () => {
  it('reports dependency preflight', async () => {
    const k = kernel();
    registerDiagnosticsRoutes(k, { preflight, runs: makeRuns });
    const res = await k.app.request('/api/v1/diagnostics/preflight', {
      headers: { cookie: 'devguard_session=s1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preflight: PreflightStatus };
    expect(body.preflight.database).toBe(true);
    expect(body.preflight.trueforge).toBe(false);
  });

  it('lists a repository runs summary', async () => {
    const k = kernel();
    registerDiagnosticsRoutes(k, { preflight, runs: makeRuns });
    const res = await k.app.request(
      '/api/v1/repositories/11111111-2222-4333-8444-555555555555/runs?limit=20',
      {
        headers: { cookie: 'devguard_session=s1' },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ workflowType: string }>; hasMore: boolean };
    expect(body.runs[0]?.workflowType).toBe('review_remediation');
  });

  it('remediation requires idempotency and fails closed on unregistered command', async () => {
    const k = kernel();
    const submit: RemediationSubmitPort = async () => ({
      ok: false,
      code: 'COMMAND_UNKNOWN',
      detail: 'nope',
    });
    registerFindingsRemediationRoutes(k, submit);
    const res = await k.app.request('/api/v1/findings/f-1/remediation', {
      method: 'POST',
      headers: { cookie: 'devguard_session=s1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(428); // idempotency-key required
    const ok = await k.app.request('/api/v1/findings/f-1/remediation', {
      method: 'POST',
      headers: {
        cookie: 'devguard_session=s1',
        'content-type': 'application/json',
        'idempotency-key': '11111111-2222-4333-8444-555555555555',
      },
      body: '{}',
    });
    expect(ok.status).toBe(403);
  });
});

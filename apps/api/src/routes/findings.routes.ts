/**
 * C073 — security findings routes.
 *
 * GET /api/v1/workflows/:runId/security-findings  normalized stable findings.
 *
 * Findings are untrusted scanner output normalized by the C051/C052 layer; this
 * route surfaces only the normalized stable findings (id/severity/status/refs),
 * never raw scanner text or secrets. Session-required.
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface SecurityFinding {
  readonly id: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly status: 'open' | 'fixed' | 'not_fixed' | 'inconclusive' | 'superseded' | 'blocked';
  readonly rule?: string | undefined;
}

export interface FindingsPort {
  listFor(runId: string): Promise<readonly SecurityFinding[]>;
}

export function registerFindingsRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  findings: FindingsPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId/security-findings',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined)
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      const list = await findings.listFor(c.req.param('runId') ?? '');
      return c.json({ findings: list });
    },
  );
}

/**
 * CP015 (C065/C074) — remaining /api/v1 resource routes.
 *
 * - GET /api/v1/repositories/:repositoryId/runs    C065 runs summary (keyset page)
 * - GET /api/v1/diagnostics/preflight             C074 dependency statuses
 *
 * Thin handlers; authorization is repo-scoped via the kernel for the runs path.
 */
import type { RegisterV1Route } from '../transport/kernel.js';
import type { RunRow } from '@devguard/workflows';

export interface PreflightStatus {
  readonly database: boolean;
  readonly redis: boolean;
  readonly trueforge: boolean;
  readonly sandbox: boolean;
  readonly github: boolean;
}

export type RunsSummaryPort = (input: {
  repositoryId: string;
  limit: number;
  cursor?: { createdAtIso: string; id: string } | undefined;
}) => Promise<{ runs: readonly RunRow[]; hasMore: boolean }>;

export function registerDiagnosticsRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  input: { preflight: PreflightStatus; runs: RunsSummaryPort },
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/diagnostics/preflight',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => c.json({ preflight: input.preflight }),
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/runs',
    {
      rateLimitClass: 'default',
      authClass: 'required_session',
      capability: 'repository:read',
      repositoryIdParam: 'repositoryId',
    },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined) {
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
      }
      const repositoryId = c.req.param('repositoryId') ?? '';
      const rawLimit = Number(c.req.query('limit') ?? '20');
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
        : 20;
      const rawCursor = c.req.query('cursor');
      const cursor = rawCursor !== undefined ? safeParseCursor(rawCursor) : undefined;
      const page = await input.runs({ repositoryId, limit, cursor });
      return c.json({
        runs: page.runs.map((r) => ({
          id: r.id,
          workflowType: r.workflowType,
          status: r.status,
          createdAtIso: r.createdAtIso,
          repositoryId: r.repositoryId,
        })),
        hasMore: page.hasMore,
      });
    },
  );
}

function safeParseCursor(raw: string): { createdAtIso: string; id: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as { createdAtIso?: unknown; id?: unknown };
    if (typeof parsed.createdAtIso !== 'string' || typeof parsed.id !== 'string') return undefined;
    return { createdAtIso: parsed.createdAtIso, id: parsed.id };
  } catch {
    return undefined;
  }
}

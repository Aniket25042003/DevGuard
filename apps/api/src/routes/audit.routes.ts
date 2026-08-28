/**
 * C072 — audit routes.
 *
 * GET /api/v1/audit  authorized, integrity-verified audit log (safe summaries).
 *
 * Records are immutable and hash-chained; the response surfaces only safe,
 * non-payload summaries. Session-required and role-gated at the app layer.
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface AuditRow {
  readonly id: string;
  readonly occurredAtIso: string;
  readonly changeKind: string;
  readonly summary: string;
  readonly actor?: { readonly id?: string; readonly type?: string } | undefined;
}

export interface AuditPort {
  list(userId: string): Promise<{ verified: boolean; rows: readonly AuditRow[] }>;
}

export function registerAuditRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  audit: AuditPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/audit',
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
      const result = await audit.list(principal.userId);
      if (!result.verified) {
        return c.json(
          {
            error: {
              code: 'AUDIT_INTEGRITY_MISMATCH',
              message: 'Audit log integrity cannot be verified.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          500,
        );
      }
      return c.json({ audit: result.rows });
    },
  );
}

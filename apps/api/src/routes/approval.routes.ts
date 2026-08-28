/**
 * C070 — approvals routes.
 *
 * GET  /api/v1/workflows/:runId/approvals           list of approval states
 * POST /api/v1/workflows/:runId/approvals/:approvalId  approve | reject
 *
 * Session-required; each action is persisted BEFORE it takes effect (approved
 * resolution is durable); CSRF-protected at the app layer; rejections carry no
 * ability to resume (C059 gates resumption on APPROVED + current generation).
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface ApprovalProjection {
  readonly approvalId: string;
  readonly state: string;
  readonly reason?: string | undefined;
}

export interface ApprovalFields {
  readonly approvalId: string;
  readonly state: string;
}

export interface ApprovalPort {
  listFor(runId: string): Promise<readonly ApprovalProjection[]>;
  resolve(
    runId: string,
    approvalId: string,
    resolution: 'approved' | 'rejected',
    userId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
}

export function registerApprovalRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  approvals: ApprovalPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId/approvals',
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
      const list = await approvals.listFor(c.req.param('runId') ?? '');
      return c.json({ approvals: list });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/workflows/:runId/approvals/:approvalId',
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
      const body = (await c.req.json().catch(() => undefined)) as { action?: unknown } | undefined;
      const action = body?.action;
      if (action !== 'approve' && action !== 'reject') {
        return c.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'action must be approve or reject.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          400,
        );
      }
      const runId = c.req.param('runId') ?? '';
      const approvalId = c.req.param('approvalId') ?? '';
      const result = await approvals.resolve(
        runId,
        approvalId,
        action === 'approve' ? 'approved' : 'rejected',
        principal.userId,
      );
      if (!result.ok)
        return c.json(
          {
            error: {
              code: result.code,
              message: result.detail,
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          400,
        );
      return c.json({ resolved: true, approvalId });
    },
  );
}

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
  readonly repositoryId?: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly actionType?: string | undefined;
  readonly riskClass?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export interface ApprovalFields {
  readonly approvalId: string;
  readonly state: string;
}

export interface ApprovalPort {
  listFor(runId: string, userId: string): Promise<readonly ApprovalProjection[]>;
  resolve(
    runId: string,
    approvalId: string,
    resolution: 'approved' | 'rejected',
    userId: string,
    options?: { readonly idempotencyKey: string; readonly expectedVersion: number },
  ): Promise<{ ok: true } | { ok: false; code: string; detail: string }>;
}

export function registerApprovalRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  approvals: ApprovalPort,
  authorize?: (input: { repositoryId: string; userId: string; requestId: string }) => Promise<void>,
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
      const list = await approvals.listFor(c.req.param('runId') ?? '', principal.userId);
      if (authorize !== undefined && list[0]?.repositoryId !== undefined) {
        try {
          await authorize({
            repositoryId: list[0].repositoryId,
            userId: principal.userId,
            requestId: c.get('requestContext').requestId,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'REPOSITORY_FORBIDDEN') throw error;
          return c.json(
            {
              error: {
                code: 'APPROVAL_UNKNOWN',
                message: 'Approval not found.',
                requestId: c.get('requestContext').requestId,
                retryable: false,
              },
            },
            404,
          );
        }
      }
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
      if (authorize !== undefined) {
        const visible = (await approvals.listFor(runId, principal.userId)).find(
          (approval) => approval.approvalId === approvalId,
        );
        if (visible?.repositoryId === undefined) {
          return c.json(
            {
              error: {
                code: 'APPROVAL_UNKNOWN',
                message: 'Approval was not found.',
                requestId: c.get('requestContext').requestId,
                retryable: false,
              },
            },
            404,
          );
        }
        try {
          await authorize({
            repositoryId: visible.repositoryId,
            userId: principal.userId,
            requestId: c.get('requestContext').requestId,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'REPOSITORY_FORBIDDEN') throw error;
          return c.json(
            {
              error: {
                code: 'APPROVAL_UNKNOWN',
                message: 'Approval was not found.',
                requestId: c.get('requestContext').requestId,
                retryable: false,
              },
            },
            404,
          );
        }
      }
      const idempotencyKey = c.req.header('idempotency-key');
      const ifMatch = c.req.header('if-match');
      if (idempotencyKey === undefined || idempotencyKey.trim().length < 8) {
        return c.json(
          {
            error: {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
              message: 'Idempotency-Key is required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          428,
        );
      }
      if (ifMatch === undefined || !/^\d+$/.test(ifMatch)) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message: 'If-Match (approval version) is required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          428,
        );
      }
      const result = await approvals.resolve(
        runId,
        approvalId,
        action === 'approve' ? 'approved' : 'rejected',
        principal.userId,
        { idempotencyKey, expectedVersion: Number(ifMatch) },
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

/**
 * C066/C067/C069 — policies, workflows, and command routes.
 *
 * GET /api/v1/policies                         session-required safe policy summary
 * POST /api/v1/workflows                       launch a workflow (idempotent by idempotencyKey)
 * GET  /api/v1/workflows/:runId                status projection
 * GET  /api/v1/workflows/:runId/commands       redacted command catalog
 *
 * Launch validates requested version + input; responses are safe projections and
 * push/idempotency stay server-side (C067). Command catalog shows redacted argv
 * + class + state, never secrets or raw output (C069).
 */
import { WorkflowKind } from '@devguard/contracts';
import type { RegisterV1Route } from '../transport/kernel.js';

export interface PolicySummaryPort {
  summaryFor(userId: string): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
}

export function registerPolicyRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  policies: PolicySummaryPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/policies',
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
      const list = await policies.summaryFor(principal.userId);
      return c.json({ policies: list });
    },
  );
}

export interface WorkflowLaunchInput {
  readonly workflowType: string;
  readonly version: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
}

export interface WorkflowLaunchPort {
  launch(
    input: WorkflowLaunchInput,
    userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  >;
}

export interface WorkflowStatusPort {
  statusOf(runId: string, userId: string): Promise<{ runId: string; state: string } | undefined>;
}

export function registerWorkflowRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  launch: WorkflowLaunchPort,
  status: WorkflowStatusPort,
): void {
  kernel.registerV1Route(
    'post',
    '/api/v1/workflows',
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
      const body = (await c.req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (
        body === undefined ||
        typeof body.workflowType !== 'string' ||
        typeof body.version !== 'string' ||
        typeof body.idempotencyKey !== 'string' ||
        !WorkflowKind.safeParse(body.workflowType).success ||
        body.workflowType.length === 0 ||
        body.version.length === 0 ||
        body.idempotencyKey.length === 0 ||
        typeof body.input !== 'object' ||
        body.input === null ||
        Array.isArray(body.input)
      ) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'workflowType, version, idempotencyKey required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          400,
        );
      }
      const result = await launch.launch(
        {
          workflowType: body.workflowType,
          version: body.version,
          idempotencyKey: body.idempotencyKey,
          input: body.input,
        },
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
      c.status(result.replayed ? 200 : 202);
      return c.json({ runId: result.runId, replayed: result.replayed });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      const runId = c.req.param('runId') ?? '';
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
      const projection = await status.statusOf(runId, principal.userId);
      if (projection === undefined)
        return c.json(
          {
            error: {
              code: 'WORKFLOW_UNKNOWN',
              message: 'Workflow run not found.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          404,
        );
      return c.json(projection);
    },
  );
}

export interface CommandCatalogPort {
  commandsOf(
    runId: string,
    userId: string,
  ): Promise<
    Array<{
      commandId: string;
      class: string;
      state: string;
      argvRedacted: readonly string[];
      exitCode?: number | null;
    }>
  >;
}

export function registerCommandRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  catalog: CommandCatalogPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId/commands',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      const runId = c.req.param('runId') ?? '';
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
      const commands = await catalog.commandsOf(runId, principal.userId);
      return c.json({ commands });
    },
  );
}

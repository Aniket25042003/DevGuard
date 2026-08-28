/**
 * CP006 — repository-scoped command bus routes (C069).
 *
 * GET  /api/v1/repositories/:repositoryId/commands   catalog of launchable
 *       commands (capability `repository:read`).
 * POST /api/v1/repositories/:repositoryId/commands   submit a command →
 *       durable queued run + outbox in one transaction (capability
 *       `workflow:start`), REQUIRES an Idempotency-Key header.
 *
 * Origin handling (locked, CP006 §11): the server decides — an HTTP client may
 * only assert `web`/`cli`. Presenting `github_comment`/`github_event`/`schedule`
 * in the body is rejected as `ORIGIN_FORGED` (400); nothing corrective is ever
 * inferred. Route stays thin: all rules live in the `CommandBus` use case.
 */
import type { ApiContainer } from '../composition/container.js';
import {
  commandReceiptSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  submitCommandRequestSchema,
} from '@devguard/api-contracts';
import { validationFailed } from '@devguard/errors';
import { CommandDisabledError, CommandOriginForgedError } from '@devguard/workflows';
import { CommandUnknownError } from '@devguard/policy-engine';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';

const HTTP_SURFACES = new Set(['web', 'cli']);

export function registerRepositoryCommandRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
): void {
  const listMeta: RouteMetadata = {
    rateLimitClass: 'default',
    authClass: 'required_session',
    capability: 'repository:read',
    repositoryIdParam: 'repositoryId',
  };
  const submitMeta: RouteMetadata = {
    rateLimitClass: 'default',
    authClass: 'required_session',
    capability: 'workflow:start',
    repositoryIdParam: 'repositoryId',
  };

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/commands',
    listMeta,
    async (c) => {
      const commands = container.commandBus.listAvailable();
      return c.json({ data: { commands } });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/repositories/:repositoryId/commands',
    submitMeta,
    async (c) => {
      const repositoryId = c.req.param('repositoryId');
      const principal = c.get('requestContext').principal!;
      if (repositoryId === undefined || repositoryId.length === 0) {
        throw validationFailed([{ path: 'repositoryId', constraint: 'required' }]);
      }

      const rawIdempotency = c.req.header(IDEMPOTENCY_KEY_HEADER);
      const parsedKey = idempotencyKeySchema.safeParse(rawIdempotency);
      if (!parsedKey.success) {
        throw validationFailed([
          { path: IDEMPOTENCY_KEY_HEADER, constraint: 'valid idempotency key required' },
        ]);
      }

      const body = await c.req.json().catch(() => undefined);
      const parsed = submitCommandRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw validationFailed([{ path: 'body', constraint: 'submitCommandRequestV1 required' }]);
      }

      // Fail closed on fabricated server surfaces (CP006 §11 locked).
      if (!HTTP_SURFACES.has(parsed.data.originSurface)) {
        return renderCommandError(c, new CommandOriginForgedError(parsed.data.originSurface));
      }

      let result;
      try {
        result = await container.commandBus.submit({
          command: {
            commandId: parsed.data.commandId,
            ...(parsed.data.definitionVersion !== undefined
              ? { definitionVersion: parsed.data.definitionVersion }
              : {}),
            input: parsed.data.input,
          },
          repositoryId,
          originSurface: parsed.data.originSurface,
          idempotencyKey: parsedKey.data,
          createdBy: principal.userId,
        });
      } catch (error) {
        return renderCommandError(c, error);
      }

      // Canonical C069 CommandReceiptV1 on both created (202) and replayed (200).
      const receipt = commandReceiptSchema.parse({
        id: result.runId,
        repositoryId,
        commandId: result.commandId,
        originSurface: result.originSurface,
        status: 'accepted',
        workflowRunId: result.runId,
        createdAt: result.createdAt,
        links: {
          run: `/api/v1/workflows/${result.runId}`,
          self: `/api/v1/repositories/${repositoryId}/commands`,
        },
      });

      if (result.replayed) {
        return c.json({ data: receipt }, 200);
      }
      return c.json({ data: receipt }, 202);
    },
  );
}

/** Map command-domain failures to stable HTTP envelopes (never 500). */
function renderCommandError(
  c: { get(key: 'requestContext'): { requestId: string } },
  error: unknown,
): Response {
  const requestId = c.get('requestContext').requestId;
  if (error instanceof CommandOriginForgedError) {
    return buildError(400, 'ORIGIN_FORGED', error.message, requestId);
  }
  if (error instanceof CommandUnknownError) {
    return buildError(400, 'COMMAND_UNKNOWN', error.message, requestId);
  }
  if (error instanceof CommandDisabledError) {
    return buildError(403, 'COMMAND_NO_LONGER_ALLOWED', error.message, requestId);
  }
  throw error;
}

function buildError(status: number, code: string, message: string, requestId: string): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId, retryable: false } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

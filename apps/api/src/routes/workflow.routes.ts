/**
 * CP007 / C066–C069 — policies, workflow start/list/get/cancel, command routes.
 *
 * Repo-scoped (capability-gated) routes:
 *   POST /api/v1/repositories/:repositoryId/workflows   start (alias of the
 *       command submit use case; CP007 §28)
 *   GET  /api/v1/repositories/:repositoryId/workflows   list (durable, keyset)
 * Run-scoped routes:
 *   GET  /api/v1/workflows/:runId                        durable status/get
 *   POST /api/v1/workflows/:runId/cancel                 cooperative cancel
 *   GET  /api/v1/workflows/:runId/commands               redacted command catalog
 *
 * The deprecated launch stub `POST /api/v1/workflows` is REMOVED (CP007 §27) —
 * there is a single start path.
 */
import { WorkflowStatus } from '@devguard/contracts';
import { requireAllow } from '@devguard/authorization';
import { repositoryForbidden } from '@devguard/errors';
import {
  canonicalCommandIdSchema,
  commandReceiptSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  originSurfaceSchema,
  submitCommandRequestSchema,
  triggerTypeSchema,
  workflowRunDtoSchema,
  type WorkflowRunDtoV1,
} from '@devguard/api-contracts';
import {
  CommandDisabledError,
  CommandOriginForgedError,
  MAX_RUN_LIMIT,
  type RunRow,
  type OriginSurfaceV1,
  type TriggerTypeV1,
} from '@devguard/workflows';
import { CommandUnknownError } from '@devguard/policy-engine';
import { validationFailed } from '@devguard/errors';
import type { Principal } from '@devguard/auth';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';
import type { ApiContainer } from '../composition/container.js';

const HTTP_SURFACES = new Set(['web', 'cli']);

// CP016 provenance list filters (validation gates the SQL WHERE by allow-list).
const TRIGGER_TYPES: ReadonlySet<TriggerTypeV1> = new Set(['manual', 'webhook', 'api', 'schedule']);
const ORIGIN_SURFACES: ReadonlySet<OriginSurfaceV1> = new Set([
  'web',
  'cli',
  'github_comment',
  'github_event',
  'schedule',
]);

function parseProvenanceFilter<T extends string>(
  value: string | undefined,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.has(value as T)) {
    throw validationFailed([{ path: 'filters', constraint: 'unknown provenance filter value' }]);
  }
  return value as T;
}

/** Port types referenced by the composition root bindings (kept for stability). */
export interface PolicySummaryPort {
  summaryFor(userId: string): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
}
export interface WorkflowLaunchPort {
  launch(
    input: {
      workflowType: string;
      version: string;
      idempotencyKey: string;
      input: unknown;
    },
    userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  >;
}
export interface WorkflowStatusPort {
  statusOf(runId: string, userId: string): Promise<{ runId: string; state: string } | undefined>;
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

function toRunDto(run: RunRow): WorkflowRunDtoV1 {
  return workflowRunDtoSchema.parse({
    id: run.id,
    repositoryId: run.repositoryId,
    workflowType: canonicalCommandIdSchema.parse(run.workflowType),
    definitionVersion: String(run.definitionVersion),
    status: WorkflowStatus.parse(run.status),
    trigger: {
      triggerType: triggerTypeSchema.parse(run.triggerType),
      originSurface: originSurfaceSchema.parse(run.originSurface),
    },
    ...(run.startedAtIso !== undefined ? { startedAt: run.startedAtIso } : {}),
    ...(run.completedAtIso !== undefined ? { completedAt: run.completedAtIso } : {}),
    createdAt: run.createdAtIso,
    updatedAt: run.updatedAtIso,
    version: run.rowVersion,
    links: { self: `/api/v1/workflows/${run.id}` },
  });
}

/** Authorize a run-scoped route against the run's own repository. */
async function authorizeRun(
  container: ApiContainer,
  principal: Principal | undefined,
  requestId: string,
  repositoryId: string,
  capability: 'repository:read' | 'workflow:cancel',
): Promise<void> {
  if (principal === undefined) throw repositoryForbidden(new Error('no_principal'));
  const decision = await container.authorizer.authorize({
    principal: {
      kind: 'user',
      userId: principal.userId,
      issuer: principal.issuer,
      providerSubject: principal.providerSubject ?? principal.userId,
    },
    repositoryId,
    capability,
  });
  requireAllow(decision, requestId);
}

export function registerPolicyRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
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
      const list = await container.bindings.policies.summaryFor(principal.userId);
      return c.json({ policies: list });
    },
  );
}

const startMeta: RouteMetadata = {
  rateLimitClass: 'default',
  authClass: 'required_session',
  capability: 'workflow:start',
  repositoryIdParam: 'repositoryId',
};

const listMeta: RouteMetadata = {
  rateLimitClass: 'default',
  authClass: 'required_session',
  capability: 'repository:read',
  repositoryIdParam: 'repositoryId',
};

export function registerWorkflowRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
): void {
  // POST start = alias of the command submit use case (single start path).
  kernel.registerV1Route(
    'post',
    '/api/v1/repositories/:repositoryId/workflows',
    startMeta,
    async (c) => {
      const repositoryId = c.req.param('repositoryId');
      const principal = c.get('requestContext').principal!;
      if (repositoryId === undefined || repositoryId.length === 0) {
        throw validationFailed([{ path: 'repositoryId', constraint: 'required' }]);
      }
      const rawIdempotency = c.req.header(IDEMPOTENCY_KEY_HEADER);
      const parsedKey = idempotencyKeySchema.safeParse(rawIdempotency);
      if (!parsedKey.success) {
        throw validationFailed([{ path: 'idempotencyKey', constraint: 'required' }]);
      }
      const body = await c.req.json().catch(() => undefined);
      const parsed = submitCommandRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw validationFailed([{ path: 'body', constraint: 'submitCommandRequestV1 required' }]);
      }
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
          self: `/api/v1/repositories/${repositoryId}/workflows`,
        },
      });
      return c.json({ data: receipt }, result.replayed ? 200 : 202);
    },
  );

  // GET list (durable keyset pagination).
  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/workflows',
    listMeta,
    async (c) => {
      const repositoryId = c.req.param('repositoryId');
      if (repositoryId === undefined || repositoryId.length === 0) {
        throw validationFailed([{ path: 'repositoryId', constraint: 'required' }]);
      }
      const raw = c.req.query();
      let limit: number | undefined;
      if (raw.limit !== undefined) {
        limit = Number(raw.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_LIMIT) {
          throw validationFailed([{ path: 'limit', constraint: `1..${MAX_RUN_LIMIT}` }]);
        }
      }
      // CP016 provenance filters (triggerType + originSurface, alias triggerSource).
      if (
        raw.originSurface !== undefined &&
        raw.triggerSource !== undefined &&
        raw.originSurface !== raw.triggerSource
      ) {
        throw validationFailed([{ path: 'filters', constraint: 'conflicting provenance aliases' }]);
      }
      const triggerType = parseProvenanceFilter(raw.triggerType, TRIGGER_TYPES);
      const originSurface = parseProvenanceFilter(
        raw.originSurface ?? raw.triggerSource,
        ORIGIN_SURFACES,
      );
      const page = await container.workflowQueries.listRuns({
        repositoryId,
        ...(limit !== undefined ? { limit } : {}),
        ...(raw.cursor !== undefined ? parseCursor(raw.cursor) : {}),
        ...(triggerType !== undefined ? { triggerType } : {}),
        ...(originSurface !== undefined ? { originSurface } : {}),
      });
      return c.json({
        data: {
          runs: page.runs.map(toRunDto),
          hasMore: page.hasMore,
          ...(page.nextCursor !== undefined
            ? { nextCursor: `${page.nextCursor.id}:${page.nextCursor.createdAtIso}` }
            : {}),
        },
      });
    },
  );

  // GET single run (durable; non-enumerating 404 on denial/absence).
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const runId = c.req.param('runId') ?? '';
      const run = await container.workflowQueries.getRun(runId);
      if (run === null) return workflowUnknown(c);
      try {
        await authorizeRun(
          container,
          c.get('requestContext').principal,
          c.get('requestContext').requestId,
          run.repositoryId,
          'repository:read',
        );
      } catch {
        return workflowUnknown(c);
      }
      return c.json({ data: toRunDto(run) });
    },
  );

  // POST cancel (cooperative; If-Match/version required).
  kernel.registerV1Route(
    'post',
    '/api/v1/workflows/:runId/cancel',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const runId = c.req.param('runId') ?? '';
      const ifMatch = c.req.header('if-match');
      if (ifMatch === undefined || !/^\d+$/.test(ifMatch)) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message: 'If-Match (row version) is required to cancel.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          428,
        );
      }
      const run = await container.workflowQueries.getRun(runId);
      if (run === null) return workflowUnknown(c);
      try {
        await authorizeRun(
          container,
          c.get('requestContext').principal,
          c.get('requestContext').requestId,
          run.repositoryId,
          'workflow:cancel',
        );
      } catch {
        return workflowUnknown(c);
      }
      const outcome = await container.workflowQueries.cancel(runId, Number(ifMatch));
      if (!outcome.ok) {
        return c.json(
          {
            error: {
              code: outcome.code,
              message: 'Cancel rejected.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          outcome.code === 'WORKFLOW_UNKNOWN'
            ? 404
            : outcome.code === 'PRECONDITION_FAILED'
              ? 409
              : 400,
        );
      }
      return c.json({ data: toRunDto(outcome.run) });
    },
  );
}

function workflowUnknown(c: {
  get(key: 'requestContext'): { requestId: string };
  json(body: Record<string, unknown>, status?: number): Response;
}): Response {
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
}

function parseCursor(value: string): { cursor?: { createdAtIso: string; id: string } } {
  const [, second] = value.split(':');
  const [createdAt, ...rest] = (second ?? value).split(',');
  const id = rest.join(',');
  return createdAt !== undefined && id !== undefined
    ? { cursor: { createdAtIso: createdAt, id } }
    : {};
}

/** Map command-domain failures to stable HTTP envelopes (never 500). */
function renderCommandError(
  c: { get(key: 'requestContext'): { requestId: string } },
  error: unknown,
): Response {
  const requestId = c.get('requestContext').requestId;
  if (error instanceof CommandOriginForgedError)
    return buildError(400, 'ORIGIN_FORGED', error.message, requestId);
  if (error instanceof CommandUnknownError)
    return buildError(400, 'COMMAND_UNKNOWN', error.message, requestId);
  if (error instanceof CommandDisabledError)
    return buildError(403, 'COMMAND_NO_LONGER_ALLOWED', error.message, requestId);
  throw error;
}

function buildError(status: number, code: string, message: string, requestId: string): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId, retryable: false } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** C069 run-scoped redacted command catalog projection. */
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

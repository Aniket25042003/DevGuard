/**
 * CP018 prerequisite — thin /api/v1 aliases the web surface needs:
 * repository get/connect, GitHub installation list/intent, policy CRUD,
 * top-level approvals. Domain logic stays in existing stores/use cases.
 */
import { createHash } from 'node:crypto';
import { repositoryPolicyV1 } from '@devguard/policy-engine';
import { validationFailed } from '@devguard/errors';
import {
  ApprovalStore,
  ConnectedRepositoryStore,
  InstallationStore,
  PolicyVersionStore,
  uuidv7,
} from '@devguard/db';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@devguard/api-contracts';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';
import type { ApiContainer } from '../composition/container.js';
import type { ApprovalPort, ApprovalProjection } from './approval.routes.js';

const repoRead: RouteMetadata = {
  rateLimitClass: 'default',
  authClass: 'required_session',
  capability: 'repository:read',
  repositoryIdParam: 'repositoryId',
};
const repoWrite: RouteMetadata = {
  rateLimitClass: 'default',
  authClass: 'required_session',
  capability: 'policy:write',
  repositoryIdParam: 'repositoryId',
};

export function registerWebSurfaceRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
  approvals: ApprovalPort,
): void {
  const pool = container.pool;
  const repoStore = pool === undefined ? undefined : new ConnectedRepositoryStore(pool);
  const installStore = pool === undefined ? undefined : new InstallationStore(pool);
  const policyStore = pool === undefined ? undefined : new PolicyVersionStore(pool);
  const approvalStore = pool === undefined ? undefined : new ApprovalStore(pool);

  kernel.registerV1Route('get', '/api/v1/repositories/:repositoryId', repoRead, async (c) => {
    const id = c.req.param('repositoryId') ?? '';
    const row = repoStore !== undefined ? await repoStore.findById(id) : undefined;
    if (row === undefined || row === null) {
      return c.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Repository not found.',
            requestId: c.get('requestContext').requestId,
            retryable: false,
          },
        },
        404,
      );
    }
    return c.json({
      id: row.id,
      name: row.name,
      owner: row.owner,
      fullName: row.fullName,
      status: row.status,
      defaultBranch: row.defaultBranch,
      installationId: row.installationId,
    });
  });

  kernel.registerV1Route(
    'post',
    '/api/v1/repositories',
    { rateLimitClass: 'default', authClass: 'required_session' },
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
      const rawKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
      if (!idempotencyKeySchema.safeParse(rawKey).success) {
        throw validationFailed([{ path: IDEMPOTENCY_KEY_HEADER, constraint: 'required' }]);
      }
      const body = (await c.req.json().catch(() => undefined)) as
        | {
            installationId?: unknown;
            githubRepositoryId?: unknown;
            owner?: unknown;
            name?: unknown;
          }
        | undefined;
      if (
        typeof body?.installationId !== 'string' ||
        typeof body.githubRepositoryId !== 'string' ||
        typeof body.owner !== 'string' ||
        typeof body.name !== 'string'
      ) {
        throw validationFailed([
          { path: 'body', constraint: 'installationId, githubRepositoryId, owner, name required' },
        ]);
      }
      if (repoStore === undefined || installStore === undefined) {
        return c.json(
          {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'Durable repository store is not bound.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          503,
        );
      }
      const existing = await repoStore.findByGitHubId(body.githubRepositoryId);
      if (existing !== null) {
        return c.json({
          id: existing.id,
          name: existing.name,
          owner: existing.owner,
          fullName: existing.fullName,
          status: existing.status,
          installationId: existing.installationId,
        });
      }
      const installationPk = await installStore.findInternalId(body.installationId);
      if (installationPk === null) {
        return c.json(
          {
            error: {
              code: 'INSTALLATION_UNKNOWN',
              message: 'GitHub installation is not recorded for this actor.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          404,
        );
      }
      const created = await repoStore.insert({
        id: uuidv7(),
        githubRepositoryId: body.githubRepositoryId,
        installationId: installationPk,
        owner: body.owner,
        name: body.name,
        fullName: `${body.owner}/${body.name}`,
        connectedBy: principal.userId,
      });
      let current = created;
      if (current.status === 'pending') {
        try {
          current = await repoStore.transition(current.id, current.rowVersion, 'active', {});
        } catch {
          // Leave pending; the catalog still returns the row. Capability-gated
          // routes stay denied until activation succeeds.
        }
      }
      return c.json(
        {
          id: current.id,
          name: current.name,
          owner: current.owner,
          fullName: current.fullName,
          status: current.status,
          installationId: current.installationId,
        },
        201,
      );
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/github/installations',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const list =
        installStore === undefined ? [] : await installStore.listForUser(principal.userId);
      return c.json({
        installations: list.map((item) => ({
          id: item.id,
          accountLogin: item.accountLogin,
          accountType: item.accountType,
          status: item.status,
          githubInstallationId: item.githubInstallationId,
        })),
      });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/github/installations/intents',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      // GitHub owns the install UI. We return the GitHub-managed installations
      // settings URL rather than minting a Next.js OAuth workaround.
      return c.json({ installUrl: 'https://github.com/settings/installations' }, 201);
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/github/installations/:installationId/repositories',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      void c.req.param('installationId');
      // Candidate listing requires a GitHub App token lease; this route does not
      // call GitHub from a stub. The connect form accepts an explicit identity.
      return c.json({ repositories: [] });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/health',
    repoRead,
    async (c) => {
      const id = c.req.param('repositoryId') ?? '';
      const row = repoStore !== undefined ? await repoStore.findById(id) : null;
      const status = row?.status === 'active' ? 'ready' : (row?.status ?? 'unknown');
      return c.json({ status, checkedAt: new Date().toISOString() });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/policy',
    repoRead,
    async (c) => {
      const repositoryId = c.req.param('repositoryId') ?? '';
      const active = policyStore === undefined ? null : await policyStore.getActive(repositoryId);
      const repo = repoStore === undefined ? null : await repoStore.findById(repositoryId);
      const document =
        active !== null
          ? safePolicy(active.policyJson, repo?.owner ?? 'owner', repo?.name ?? 'name')
          : conservativeDefaults(repo?.owner ?? 'owner', repo?.name ?? 'name');
      return c.json({
        document,
        activeVersion: active?.version ?? 0,
        etag: active?.etag ?? '0',
        source: active !== null ? 'saved' : 'defaults',
      });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/repositories/:repositoryId/policy/validate',
    repoWrite,
    async (c) => {
      const body = (await c.req.json().catch(() => undefined)) as { draft?: unknown } | undefined;
      const parsed = repositoryPolicyV1.safeParse(body?.draft);
      if (!parsed.success) {
        return c.json({
          canonical: conservativeDefaults('owner', 'name'),
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'draft',
            message: issue.message,
          })),
          dangerChanges: [],
          draftDigest: '',
        });
      }
      const digest = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
      const dangerChanges = classifyDanger(parsed.data);
      return c.json({ canonical: parsed.data, issues: [], dangerChanges, draftDigest: digest });
    },
  );

  kernel.registerV1Route(
    'put',
    '/api/v1/repositories/:repositoryId/policy',
    repoWrite,
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const repositoryId = c.req.param('repositoryId') ?? '';
      const rawKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
      if (!idempotencyKeySchema.safeParse(rawKey).success) {
        throw validationFailed([{ path: IDEMPOTENCY_KEY_HEADER, constraint: 'required' }]);
      }
      const ifMatch = c.req.header('if-match');
      const body = (await c.req.json().catch(() => undefined)) as
        { draft?: unknown; draftDigest?: unknown } | undefined;
      const parsed = repositoryPolicyV1.safeParse(body?.draft);
      if (!parsed.success || typeof body?.draftDigest !== 'string') {
        throw validationFailed([{ path: 'body', constraint: 'validated draft required' }]);
      }
      const digest = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
      if (digest !== body.draftDigest) {
        throw validationFailed([{ path: 'draftDigest', constraint: 'must match last validate' }]);
      }
      if (policyStore === undefined) {
        return c.json(
          {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'Durable policy store is not bound.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          503,
        );
      }
      const json = JSON.stringify(parsed.data);
      const version = await policyStore.appendVersion({
        repositoryId,
        policyJson: json,
        canonicalHash: digest,
        createdBy: principal.userId,
      });
      const expected = ifMatch !== undefined && /^\d+$/.test(ifMatch) ? Number(ifMatch) : 0;
      try {
        await policyStore.activateHead(
          repositoryId,
          version.id,
          Math.max(expected, 0) || 0,
          principal.userId,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('HEAD_VERSION_CONFLICT')) {
          return c.json(
            {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Policy head changed. Reload and retry.',
                requestId: c.get('requestContext').requestId,
                retryable: false,
              },
            },
            409,
          );
        }
        throw error;
      }
      return c.json({ activeVersion: version.version, etag: String(version.version) }, 201);
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/policy/versions',
    repoRead,
    async (c) => {
      const repositoryId = c.req.param('repositoryId') ?? '';
      const versions =
        policyStore === undefined ? [] : await policyStore.listVersions(repositoryId);
      return c.json({ versions });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/approvals',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const status = c.req.query('status');
      const repositoryId = c.req.query('repositoryId');
      if (approvalStore !== undefined) {
        const rows = await approvalStore.list({
          ...(status !== undefined ? { status } : {}),
          ...(repositoryId !== undefined ? { repositoryId } : {}),
        });
        return c.json({
          approvals: rows.map((row) => toApproval(row)),
        });
      }
      const nested = await approvals.listFor('', principal.userId);
      return c.json({ approvals: nested });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/approvals/:approvalId/approve',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const approvalId = c.req.param('approvalId') ?? '';
      const result = await approvals.resolve('', approvalId, 'approved', principal.userId);
      if (!result.ok) {
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
      }
      return c.json({ resolved: true, approvalId });
    },
  );
  kernel.registerV1Route(
    'post',
    '/api/v1/approvals/:approvalId/reject',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const approvalId = c.req.param('approvalId') ?? '';
      const result = await approvals.resolve('', approvalId, 'rejected', principal.userId);
      if (!result.ok) {
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
      }
      return c.json({ resolved: true, approvalId });
    },
  );
}

function toApproval(row: Record<string, unknown>): ApprovalProjection {
  return {
    approvalId: String(row['id'] ?? row['approvalId'] ?? ''),
    state: String(row['status'] ?? row['state'] ?? 'pending'),
    reason: typeof row['reasonSummary'] === 'string' ? row['reasonSummary'] : undefined,
    repositoryId: typeof row['repositoryId'] === 'string' ? row['repositoryId'] : undefined,
    workflowRunId: typeof row['workflowRunId'] === 'string' ? row['workflowRunId'] : undefined,
    actionType: typeof row['actionType'] === 'string' ? row['actionType'] : undefined,
    riskClass: typeof row['riskClass'] === 'string' ? row['riskClass'] : undefined,
    expiresAt: typeof row['expiresAt'] === 'string' ? row['expiresAt'] : undefined,
  };
}

function conservativeDefaults(owner: string, name: string) {
  return {
    schemaVersion: 1 as const,
    repository: { owner, name },
    autonomy: { level: 'assist' as const },
    triggers: {},
    manualCommands: [
      'review_remediation',
      'diagnose_failure',
      'security_audit',
      'security_patch',
      'implement_issue',
    ],
    actions: {
      allow: ['repository.read', 'issue.read', 'file.read'],
      requireApproval: ['pull_request.merge', 'workflow_file.write'],
      deny: [],
    },
    validation: { obligations: ['run_tests'] },
    limits: { maxFilesChanged: 25, maxIterations: 6, maxRuntimeMinutes: 20 },
  };
}

function safePolicy(json: string, owner: string, name: string) {
  try {
    const parsed = repositoryPolicyV1.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : conservativeDefaults(owner, name);
  } catch {
    return conservativeDefaults(owner, name);
  }
}

function classifyDanger(draft: {
  readonly autonomy: { readonly level: string };
  readonly limits: { readonly maxFilesChanged?: number | undefined };
}): string[] {
  const danger: string[] = [];
  if (draft.autonomy.level === 'autonomous' || draft.autonomy.level === 'trusted') {
    danger.push('Autonomy is broader than assist.');
  }
  if ((draft.limits.maxFilesChanged ?? 0) > 25) {
    danger.push('File-change limit is above the conservative default of 25.');
  }
  return danger;
}

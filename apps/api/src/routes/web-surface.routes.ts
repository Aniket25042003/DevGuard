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
} from '@devguard/db';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@devguard/api-contracts';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';
import type { ApiContainer } from '../composition/container.js';
import type { ApprovalPort, ApprovalProjection } from './approval.routes.js';
import type { RepositoryLifecycleService, RepositoryMetadataHealthService } from '@devguard/github-adapter';
import { completeGitHubInstallationSetup } from '../composition/github-installation-setup.js';
import { listGitHubInstallationRepositories } from '../composition/github-installation-repositories.js';

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
  const lifecycle: RepositoryLifecycleService | undefined =
    container.repositoryServices?.lifecycle;
  const metadataHealth: RepositoryMetadataHealthService | undefined =
    container.repositoryServices?.metadataHealth;
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
      const body = (await c.req.json().catch(() => undefined)) as
        | {
            installationId?: unknown;
            githubRepositoryId?: unknown;
            owner?: unknown;
            name?: unknown;
            defaultBranch?: unknown;
            visibility?: unknown;
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
      const idempotencyKey = idempotencyKeySchema.parse(c.req.header(IDEMPOTENCY_KEY_HEADER));
      if (repoStore === undefined || installStore === undefined || lifecycle === undefined) {
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
      const outcome = await lifecycle.connect({
        actorId: principal.userId,
        installationId: installationPk,
        githubRepositoryId: Number(body.githubRepositoryId),
        idempotencyKey,
        ownerLogin: body.owner,
        repoName: body.name,
        defaultBranch:
          typeof body.defaultBranch === 'string' && body.defaultBranch.length > 0
            ? body.defaultBranch
            : 'main',
        visibility: body.visibility === 'public' ? 'public' : 'private',
      });
      if (outcome.outcome === 'BLOCKED') {
        return c.json(
          {
            error: {
              code: outcome.code,
              message: outcome.detail,
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          403,
        );
      }
      const record = outcome.record;
      await pool!.query({
        text: `UPDATE repositories SET connected_by = $1, connected_at = COALESCE(connected_at, now()) WHERE id = $2`,
        values: [principal.userId, record.repositoryDevguardId],
      });
      if (metadataHealth !== undefined && outcome.outcome === 'CONNECTED') {
        void metadataHealth.refresh({
          repositoryId: record.repositoryDevguardId,
          cause: 'connect',
          operationKey: idempotencyKey,
        });
      }
      const status =
        record.status === 'connected'
          ? 'active'
          : record.status === 'degraded'
            ? 'degraded'
            : 'disconnected';
      return c.json(
        {
          id: record.repositoryDevguardId,
          name: record.repoName,
          owner: record.ownerLogin,
          fullName: record.fullName,
          status,
          installationId: record.installationId,
        },
        outcome.outcome === 'CONNECTED' ? 201 : 200,
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
      const slug = container.config?.github?.appSlug;
      if (slug === undefined || slug.length === 0) {
        return c.json(
          {
            error: {
              code: 'INSTALL_INTENT_UNAVAILABLE',
              message: 'GitHub App slug is not configured for installation.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          503,
        );
      }
      return c.json({ installUrl: `https://github.com/apps/${slug}/installations/new` }, 201);
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/github/installations/complete',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const body = (await c.req.json().catch(() => undefined)) as
        | { githubInstallationId?: unknown }
        | undefined;
      if (
        typeof body?.githubInstallationId !== 'string' ||
        !/^\d{1,20}$/.test(body.githubInstallationId)
      ) {
        throw validationFailed([
          { path: 'githubInstallationId', constraint: 'numeric GitHub installation id required' },
        ]);
      }
      const github = container.config.github;
      const privateKeyPem =
        github !== undefined &&
        github.privateKeyRef !== undefined &&
        github.privateKeyRef.length > 0 &&
        !github.privateKeyRef.startsWith('<')
          ? github.privateKeyRef
          : undefined;
      if (pool === undefined || github === undefined || privateKeyPem === undefined) {
        return c.json(
          {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'GitHub App credentials are not configured on the API.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          503,
        );
      }
      try {
        const result = await completeGitHubInstallationSetup({
          pool,
          github,
          privateKeyPem,
          userId: principal.userId,
          githubInstallationId: body.githubInstallationId,
        });
        return c.json(
          {
            installationId: result.installationId,
            accountLogin: result.accountLogin,
          },
          201,
        );
      } catch {
        return c.json(
          {
            error: {
              code: 'GITHUB_INSTALLATION_UNAVAILABLE',
              message:
                'Could not verify the GitHub App installation. Confirm the app is installed and API credentials match.',
              requestId: c.get('requestContext').requestId,
              retryable: true,
            },
          },
          502,
        );
      }
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/github/installations/:installationId/repositories',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const installationRef = c.req.param('installationId') ?? '';
      const cursor = c.req.query('cursor');
      const query = c.req.query('q');
      const github = container.config.github;
      const privateKeyPem =
        github !== undefined &&
        github.privateKeyRef !== undefined &&
        github.privateKeyRef.length > 0 &&
        !github.privateKeyRef.startsWith('<')
          ? github.privateKeyRef
          : undefined;
      if (pool === undefined || github === undefined || privateKeyPem === undefined) {
        return c.json(
          {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'GitHub App credentials are not configured on the API.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          503,
        );
      }
      try {
        const result = await listGitHubInstallationRepositories({
          pool,
          github,
          privateKeyPem,
          userId: principal.userId,
          installationRef,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(query !== undefined ? { query } : {}),
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof Error && error.message === 'installation_not_linked') {
          return c.json(
            {
              error: {
                code: 'INSTALLATION_UNKNOWN',
                message: 'GitHub installation is not linked to this account.',
                requestId: c.get('requestContext').requestId,
                retryable: false,
              },
            },
            404,
          );
        }
        return c.json(
          {
            error: {
              code: 'GITHUB_REPOSITORIES_UNAVAILABLE',
              message: 'Could not list repositories from GitHub for this installation.',
              requestId: c.get('requestContext').requestId,
              retryable: true,
            },
          },
          502,
        );
      }
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/repositories/:repositoryId/disconnect',
    repoRead,
    async (c) => {
      const principal = c.get('requestContext').principal!;
      const repositoryId = c.req.param('repositoryId') ?? '';
      if (repoStore === undefined || lifecycle === undefined) {
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
      const row = await repoStore.findById(repositoryId);
      if (row === null) {
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
      const owned = await repoStore.listForUser(principal.userId);
      if (!owned.some((item) => item.id === repositoryId)) {
        return c.json(
          {
            error: {
              code: 'FORBIDDEN',
              message: 'You can only disconnect repositories you connected.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          403,
        );
      }
      const outcome = await lifecycle.disconnect({ repositoryDevguardId: repositoryId });
      if (outcome.outcome !== 'DISCONNECTED') {
        return c.json(
          {
            error: {
              code: 'DISCONNECT_FAILED',
              message: 'Could not disconnect the repository.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          500,
        );
      }
      const record = outcome.record;
      const status =
        record.status === 'connected'
          ? 'active'
          : record.status === 'degraded'
            ? 'degraded'
            : 'disconnected';
      return c.json({
        id: record.repositoryDevguardId,
        name: record.repoName,
        owner: record.ownerLogin,
        fullName: record.fullName,
        status,
        installationId: record.installationId,
      });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/health',
    repoRead,
    async (c) => {
      const id = c.req.param('repositoryId') ?? '';
      if (metadataHealth === undefined || repoStore === undefined) {
        const row = repoStore !== undefined ? await repoStore.findById(id) : null;
        const status = row?.status === 'active' ? 'ready' : (row?.status ?? 'unknown');
        return c.json({ status, checkedAt: new Date().toISOString() });
      }
      const row = await repoStore.findById(id);
      if (row === null) {
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
      const view = await metadataHealth.getSnapshot({
        repositoryId: id,
        maxAgeMs: 5 * 60 * 1000,
      });
      return c.json({
        status: view.status,
        readiness: view.readiness,
        lifecycleStatus: view.lifecycleStatus,
        checkedAt: new Date().toISOString(),
        snapshotAgeMs: view.snapshotAgeMs,
        partialFieldErrors: view.partialFieldErrors,
        dimensions: view.health?.dimensions,
      });
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
      const active = await policyStore.getActive(repositoryId);
      const expected =
        ifMatch !== undefined && /^\d+$/.test(ifMatch) ? Number(ifMatch) : (active?.version ?? 0);
      if (active !== null && active.canonicalHash === digest) {
        return c.json({ activeVersion: active.version, etag: String(active.version) }, 200);
      }
      if (active !== null && active.version !== expected) {
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
      const json = JSON.stringify(parsed.data);
      const version = await policyStore.appendVersion({
        repositoryId,
        policyJson: json,
        canonicalHash: digest,
        createdBy: principal.userId,
      });
      try {
        await policyStore.activateHead(
          repositoryId,
          version.id,
          Math.max(expected, 0) || 0,
          principal.userId,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('HEAD_VERSION_CONFLICT')) {
          const latest = await policyStore.getActive(repositoryId);
          if (latest !== null && latest.canonicalHash === digest) {
            return c.json({ activeVersion: latest.version, etag: String(latest.version) }, 200);
          }
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
      const accessible =
        repoStore === undefined
          ? undefined
          : new Set((await repoStore.listForUser(principal.userId)).map((row) => row.id));
      if (repositoryId !== undefined && accessible !== undefined && !accessible.has(repositoryId)) {
        return c.json({ approvals: [] });
      }
      if (approvalStore !== undefined) {
        const rows = await approvalStore.list({
          ...(status !== undefined ? { status } : {}),
          ...(repositoryId !== undefined ? { repositoryId } : {}),
        });
        const filtered =
          accessible === undefined
            ? rows
            : rows.filter((row) => accessible.has(String(row['repositoryId'] ?? '')));
        return c.json({
          approvals: filtered.map((row) => toApproval(row)),
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
      const access = await assertApprovalAccess(
        approvalId,
        principal.userId,
        approvalStore,
        repoStore,
      );
      if (!access.ok) {
        return c.json(
          {
            error: {
              code: access.code,
              message: access.detail,
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          access.status,
        );
      }
      const result = await approvals.resolve(
        access.workflowRunId,
        approvalId,
        'approved',
        principal.userId,
      );
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
      const access = await assertApprovalAccess(
        approvalId,
        principal.userId,
        approvalStore,
        repoStore,
      );
      if (!access.ok) {
        return c.json(
          {
            error: {
              code: access.code,
              message: access.detail,
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          access.status,
        );
      }
      const result = await approvals.resolve(
        access.workflowRunId,
        approvalId,
        'rejected',
        principal.userId,
      );
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

async function assertApprovalAccess(
  approvalId: string,
  userId: string,
  approvalStore: ApprovalStore | undefined,
  repoStore: ConnectedRepositoryStore | undefined,
): Promise<
  | { ok: true; workflowRunId: string }
  | { ok: false; code: string; detail: string; status: 403 | 404 }
> {
  if (approvalStore === undefined) {
    return {
      ok: false,
      code: 'APPROVAL_UNKNOWN',
      detail: 'Approval was not found.',
      status: 404,
    };
  }
  const row = await approvalStore.getById(approvalId);
  if (row === null) {
    return {
      ok: false,
      code: 'APPROVAL_UNKNOWN',
      detail: 'Approval was not found.',
      status: 404,
    };
  }
  const repositoryId = String(row['repositoryId'] ?? '');
  if (repoStore !== undefined) {
    const accessible = new Set((await repoStore.listForUser(userId)).map((item) => item.id));
    if (!accessible.has(repositoryId)) {
      return {
        ok: false,
        code: 'REPOSITORY_FORBIDDEN',
        detail: 'You do not have access to this approval.',
        status: 403,
      };
    }
  }
  return {
    ok: true,
    workflowRunId: typeof row['workflowRunId'] === 'string' ? row['workflowRunId'] : '',
  };
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

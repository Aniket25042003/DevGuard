/**
 * Repository-scoped launch targets for workflow pickers.
 */
import {
  repositoryFindingListQuerySchema,
  repositoryTargetListQuerySchema,
} from '@devguard/api-contracts';
import type { ApiContainer } from '../composition/container.js';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';
import type { Context } from 'hono';
import type { AppEnv } from '../transport/kernel.js';
import {
  listRepositoryIssueTargets,
  listRepositoryPullRequestTargets,
  listRepositoryRefTargets,
  listRepositorySecurityFindingTargets,
} from '../composition/github-repository-targets.js';

const repoRead: RouteMetadata = {
  rateLimitClass: 'default',
  authClass: 'required_session',
  capability: 'repository:read',
  repositoryIdParam: 'repositoryId',
};

function resolvePrivateKeyPem(container: ApiContainer): string | undefined {
  const github = container.config.github;
  if (
    github === undefined ||
    github.privateKeyRef === undefined ||
    github.privateKeyRef.length === 0 ||
    github.privateKeyRef.startsWith('<')
  ) {
    return undefined;
  }
  return github.privateKeyRef;
}

function githubConfigured(container: ApiContainer): boolean {
  return (
    container.pool !== undefined &&
    container.config.github !== undefined &&
    resolvePrivateKeyPem(container) !== undefined
  );
}

function renderTargetError(c: Context<AppEnv>, error: unknown) {
  const message = error instanceof Error ? error.message : 'target_fetch_failed';
  const status =
    message === 'repository_not_found' ? 404 : message.includes('fetch_failed') ? 502 : 500;
  return c.json(
    {
      error: {
        code: status === 404 ? 'NOT_FOUND' : 'DEPENDENCY_UNAVAILABLE',
        message:
          status === 404
            ? 'Repository not found.'
            : 'Could not load launch targets from GitHub. Check App permissions and retry.',
        requestId: c.get('requestContext').requestId,
        retryable: status !== 404,
      },
    },
    status as 404,
  );
}

export function registerRepositoryTargetRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/github/pull-requests',
    repoRead,
    async (c) => {
      if (!githubConfigured(container)) {
        return c.json({ pullRequests: [] });
      }
      const repositoryId = c.req.param('repositoryId') ?? '';
      const parsed = repositoryTargetListQuerySchema.safeParse({
        state: c.req.query('state'),
        q: c.req.query('q'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      });
      if (!parsed.success) {
        return c.json({ pullRequests: [] });
      }
      try {
        const result = await listRepositoryPullRequestTargets({
          pool: container.pool!,
          github: container.config.github!,
          privateKeyPem: resolvePrivateKeyPem(container)!,
          repositoryId,
          ...(parsed.data.state !== undefined ? { state: parsed.data.state } : {}),
          ...(parsed.data.q !== undefined ? { query: parsed.data.q } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        });
        return c.json(result);
      } catch (error) {
        return renderTargetError(c, error);
      }
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/github/issues',
    repoRead,
    async (c) => {
      if (!githubConfigured(container)) {
        return c.json({ issues: [] });
      }
      const repositoryId = c.req.param('repositoryId') ?? '';
      const parsed = repositoryTargetListQuerySchema.safeParse({
        state: c.req.query('state'),
        q: c.req.query('q'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      });
      if (!parsed.success) {
        return c.json({ issues: [] });
      }
      try {
        const result = await listRepositoryIssueTargets({
          pool: container.pool!,
          github: container.config.github!,
          privateKeyPem: resolvePrivateKeyPem(container)!,
          repositoryId,
          ...(parsed.data.state !== undefined ? { state: parsed.data.state } : {}),
          ...(parsed.data.q !== undefined ? { query: parsed.data.q } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        });
        return c.json(result);
      } catch (error) {
        return renderTargetError(c, error);
      }
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/github/refs',
    repoRead,
    async (c) => {
      if (!githubConfigured(container)) {
        return c.json({ refs: [] });
      }
      const repositoryId = c.req.param('repositoryId') ?? '';
      const parsed = repositoryTargetListQuerySchema.safeParse({
        q: c.req.query('q'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      });
      if (!parsed.success) {
        return c.json({ refs: [] });
      }
      try {
        const result = await listRepositoryRefTargets({
          pool: container.pool!,
          github: container.config.github!,
          privateKeyPem: resolvePrivateKeyPem(container)!,
          repositoryId,
          ...(parsed.data.q !== undefined ? { query: parsed.data.q } : {}),
          ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        });
        return c.json(result);
      } catch (error) {
        return renderTargetError(c, error);
      }
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/repositories/:repositoryId/security-findings',
    repoRead,
    async (c) => {
      if (container.pool === undefined) {
        return c.json({ findings: [] });
      }
      const repositoryId = c.req.param('repositoryId') ?? '';
      const parsed = repositoryFindingListQuerySchema.safeParse({
        status: c.req.query('status'),
        limit: c.req.query('limit'),
      });
      if (!parsed.success) {
        return c.json({ findings: [] });
      }
      const result = await listRepositorySecurityFindingTargets({
        pool: container.pool,
        repositoryId,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      return c.json(result);
    },
  );
}

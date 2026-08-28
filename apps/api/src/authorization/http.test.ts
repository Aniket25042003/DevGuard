/**
 * CP005 §22/§25 — repository-authorization gate on a repo-scoped route.
 * Proves 401 (no principal), 403 REPOSITORY_FORBIDDEN (no linkage and
 * role-below-floor), and allow-through once the authorizer permits.
 */
import { describe, expect, it } from 'vitest';
import {
  createTransportKernel,
  type AuthResolution,
  type AuthenticateInput,
} from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { requireCapability } from './http.js';
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
  type NormalizedGitHubRole,
} from '@devguard/authorization';

interface FakeDeps {
  local: LocalRepositoryAccessPort;
  github: GitHubPermissionPort;
}

function makeKernel(deps: FakeDeps) {
  const evidence: AuthorizationEvidencePort = {
    async append() {},
    async findFresh() {
      return undefined;
    },
  };
  const authorizer = new RepositoryAuthorizationService({
    local: deps.local,
    github: deps.github,
    evidence,
    readCacheTtlSeconds: 60,
    now: () => new Date(),
  });
  const kernel = createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async (input: AuthenticateInput): Promise<AuthResolution> =>
      (input.sessionToken ?? input.bearerToken) === 'session-1'
        ? {
            status: 'authenticated',
            principal: {
              userId: 'user-1',
              issuer: 'https://github.com',
              providerSubject: 'octo',
              authMethod: 'session',
            } as never,
          }
        : { status: 'anonymous' },
    authorize: requireCapability(authorizer),
  });
  kernel.registerV1Route(
    'post',
    '/api/v1/repositories/:repositoryId/workflows',
    {
      rateLimitClass: 'default',
      authClass: 'required_session',
      capability: 'workflow:start',
      repositoryIdParam: 'repositoryId',
    },
    async (c) => c.json({ ok: true }, 202),
  );
  return kernel;
}

function active(deps?: Partial<{ role: NormalizedGitHubRole; linkage: boolean }>) {
  const role = deps?.role ?? 'admin';
  const linkage = deps?.linkage ?? true;
  const seenHints: string[] = [];
  const kernel = makeKernel({
    local: {
      async findLinkage() {
        return linkage
          ? { status: 'active', installationRef: 'inst-1', repositoryExternalIdHint: 'gh-repo-99' }
          : undefined;
      },
      async isConnectingOwner() {
        return false;
      },
    },
    github: {
      async fetchUserRole(input) {
        if (input.repositoryExternalIdHint !== undefined)
          seenHints.push(input.repositoryExternalIdHint);
        return { role, snapshotHash: `snap-${role}` };
      },
    },
  });
  return { kernel, seenHints };
}

function sessionHeaders() {
  return { cookie: 'devguard_session=session-1' };
}

/** Canonical repository id (UUID v4) accepted by the kernel gate. */
const REPO = '11111111-2222-4333-8444-555555555555';

describe('repository authorization gate (CP005 §22/§25)', () => {
  it('401 when no principal is present', async () => {
    const { kernel } = active();
    const response = await kernel.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('403 REPOSITORY_FORBIDDEN when the repository has no local linkage', async () => {
    const { kernel } = active({ linkage: false });
    const response = await kernel.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REPOSITORY_FORBIDDEN');
  });

  it('403 REPOSITORY_FORBIDDEN when the role is below the capability floor (read → workflow:start)', async () => {
    const { kernel } = active({ role: 'read' });
    const response = await kernel.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REPOSITORY_FORBIDDEN');
  });

  it('allows the controller through when the authorizer permits (admin → workflow:start)', async () => {
    const { kernel } = active({ role: 'admin' });
    const response = await kernel.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    expect(response.status).toBe(202);
  });

  it('passes the repository-specific identity to the GitHub role lookup', async () => {
    const { kernel, seenHints } = active();
    await kernel.app.request(`/api/v1/repositories/${REPO}/workflows`, {
      method: 'POST',
      headers: sessionHeaders(),
    });
    expect(seenHints).toContain('gh-repo-99');
  });

  it('rejects a malformed (non-UUID) repository id with 400 before authorization', async () => {
    const { kernel, seenHints } = active();
    const response = await kernel.app.request('/api/v1/repositories/not-a-uuid/workflows', {
      method: 'POST',
      headers: sessionHeaders(),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // Authorization must never see a malformed id.
    expect(seenHints.length).toBe(0);
  });
});

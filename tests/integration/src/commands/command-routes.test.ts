/**
 * CP006 §22/§25 — repository-scoped command routes over the full assembled API:
 * list, submit (durable receipt), idempotent dedupe, origin-forge rejection,
 * unknown/extension command mapping, and cross-repo denial via the authorizer.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@devguard/config';
import { assembleApi, buildContainer, validateReadiness, type ApiContainer } from '@devguard/api';
import type { IdentityProviderClient, ExternalIdentity } from '@devguard/auth';

const API_ENV = {
  DEVGUARD_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://y',
  AUTH_MODE: 'github_oauth',
  AUTH_SESSION_SECRET: 'session-secret-value-0123456789',
  AUTH_GITHUB_OAUTH_CLIENT_ID: 'Iv1.testclient',
  AUTH_GITHUB_OAUTH_CLIENT_SECRET: 'client-secret-value-0123456789',
  AUTH_GITHUB_OAUTH_CALLBACK_URL: 'http://localhost:3000/callback',
  DEVGUARD_PUBLIC_ORIGIN: 'http://localhost:3000',
} as const;

function fakeIdp(): IdentityProviderClient {
  return {
    buildAuthorizeUrl(input: { state: string }) {
      return `https://github.com/login/oauth/authorize?client_id=Iv1&state=${input.state}`;
    },
    async exchangeCode() {
      return { accessToken: 'tok' };
    },
    async fetchIdentity(): Promise<ExternalIdentity> {
      return { issuer: 'https://github.com', providerSubject: '1001', login: 'octocat' };
    },
  };
}

/** Grant linkage + admin role on repo-1 only; everything else fails closed. */
const authzOverrides: Parameters<typeof buildContainer>[2] = {
  identityProvider: fakeIdp(),
  localAccess: {
    async findLinkage(repositoryId: string) {
      return repositoryId === 'repo-1'
        ? { status: 'active', installationRef: 'inst-1' }
        : undefined;
    },
    async isConnectingOwner() {
      return false;
    },
  },
  githubPermissions: {
    async fetchUserRole() {
      return { role: 'admin', snapshotHash: 'snap-admin' };
    },
  },
};

function boot(): ApiContainer & ReturnType<typeof assembleApi> {
  const config = loadConfig('api', { env: { ...API_ENV } });
  const container = buildContainer(config, { ...API_ENV }, { ...authzOverrides });
  validateReadiness(config, container.bindings);
  return Object.assign(container, assembleApi(container));
}

function extract(setCookie: string | undefined, name: string): string | undefined {
  if (setCookie === undefined) return undefined;
  for (const part of setCookie.split(', ')) {
    const pair = part.split(';')[0] ?? '';
    const [key, ...rest] = pair.split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function session(api: ApiContainer & ReturnType<typeof assembleApi>) {
  const login = await api.app.request('/api/v1/auth/login');
  const state = extract(login.headers.get('set-cookie') ?? undefined, 'devguard_state')!;
  const callback = await api.app.request(`/api/v1/auth/callback?code=c1&state=${state}`, {
    headers: { cookie: `devguard_state=${state}` },
    redirect: 'manual',
  });
  const setCookie: string = callback.headers.get('set-cookie') ?? '';
  return {
    sessionToken: extract(setCookie, 'devguard_session')!,
    csrf: extract(setCookie, 'devguard_csrf')!,
  };
}

function mutationHeaders(c: { sessionToken: string; csrf: string }): Record<string, string> {
  return {
    cookie: `devguard_session=${c.sessionToken}; devguard_csrf=${c.csrf}`,
    'x-csrf-token': c.csrf,
    origin: 'http://localhost:3000',
  };
}

const KEY1 = 'idempotency-command-0001';

function submitBody(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    commandId: 'review',
    definitionVersion: '1.0.0',
    input: {},
    originSurface: 'cli',
    ...overrides,
  });
}

function errorCode(body: unknown): string {
  return (body as { error?: { code: string } }).error?.code ?? '';
}

describe('CP006 repository-scoped command routes', () => {
  it('lists only MVP commands (capability repository:read)', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      headers: { cookie: `devguard_session=${c.sessionToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { commands: Array<{ workflowId: string }> } };
    expect(body.data.commands.length).toBe(5);
    expect(body.data.commands.map((cmd) => cmd.workflowId)).not.toContain('dependency_upgrade');
  });

  it('submits a command into a durable queued run (202, not replayed)', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({}),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      data: { runId: string; replayed: boolean; status: string };
    };
    expect(body.data.runId).toBeDefined();
    expect(body.data.replayed).toBe(false);
  });

  it('dedupes a replayed idempotency key into the same run (200, one run)', async () => {
    const api = boot();
    const c = await session(api);
    const first = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({}),
    });
    const firstBody = (await first.json()) as { data: { runId: string } };
    const second = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({}),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { runId: string; replayed: boolean } };
    expect(secondBody.data.replayed).toBe(true);
    expect(secondBody.data.runId).toBe(firstBody.data.runId);
  });

  it('rejects a forged github_comment origin from an HTTP client', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({ originSurface: 'github_comment' }),
    });
    expect(response.status).toBe(400);
    expect(errorCode(await response.json())).toBe('ORIGIN_FORGED');
  });

  it('rejects an unknown command with 400 COMMAND_UNKNOWN', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({ commandId: 'no_such_command' }),
    });
    expect(response.status).toBe(400);
    expect(errorCode(await response.json())).toBe('COMMAND_UNKNOWN');
  });

  it('denies extension (non-MVP) commands with 403 COMMAND_NO_LONGER_ALLOWED', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({ commandId: 'dependency_upgrade' }),
    });
    expect(response.status).toBe(403);
    expect(errorCode(await response.json())).toBe('COMMAND_NO_LONGER_ALLOWED');
  });

  it('requires an Idempotency-Key header on submit', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-1/commands', {
      method: 'POST',
      headers: { ...mutationHeaders(c), 'content-type': 'application/json' },
      body: submitBody({}),
    });
    expect(response.status).toBe(400);
  });

  it('403 REPOSITORY_FORBIDDEN for a cross-repository submit', async () => {
    const api = boot();
    const c = await session(api);
    const response = await api.app.request('/api/v1/repositories/repo-OTHER/commands', {
      method: 'POST',
      headers: {
        ...mutationHeaders(c),
        'idempotency-key': KEY1,
        'content-type': 'application/json',
      },
      body: submitBody({}),
    });
    expect(response.status).toBe(403);
    expect(errorCode(await response.json())).toBe('REPOSITORY_FORBIDDEN');
  });
});

/**
 * CP004 §22 — kernel authentication resolution: cookie OR bearer, never both.
 */
import { describe, expect, it } from 'vitest';
import { createTransportKernel, type AuthResolution, type AuthenticateInput } from './kernel.js';
import { InMemoryRateLimiter } from './rate-limit.js';

function kernelWith(authenticate: (input: AuthenticateInput) => Promise<AuthResolution>) {
  const k = createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate,
  });
  k.registerV1Route(
    'get',
    '/api/v1/whoami',
    { authClass: 'optional_session', rateLimitClass: 'default' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      return c.json({ userId: principal?.userId, authMethod: principal?.authMethod });
    },
  );
  return k;
}

describe('kernel authentication (CP004 §22)', () => {
  it('resolves a session cookie into a principal', async () => {
    const k = kernelWith(async ({ sessionToken }) =>
      sessionToken === 'session-1'
        ? {
            status: 'authenticated',
            principal: {
              userId: 'user-1',
              authMethod: 'session',
            } as never,
          }
        : { status: 'anonymous' },
    );
    const response = await k.app.request('/api/v1/whoami', {
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user-1', authMethod: 'session' });
  });

  it('resolves a valid bearer into an api_token principal', async () => {
    const k = kernelWith(async ({ bearerToken }) =>
      bearerToken === 'dgv1_secret'
        ? {
            status: 'authenticated',
            principal: {
              userId: 'user-2',
              authMethod: 'api_token',
            } as never,
          }
        : { status: 'anonymous' },
    );
    const response = await k.app.request('/api/v1/whoami', {
      headers: { authorization: 'Bearer dgv1_secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user-2', authMethod: 'api_token' });
  });

  it('treats a malformed/non-Bearer Authorization header as absent', async () => {
    const calls: AuthenticateInput[] = [];
    const k = kernelWith(async (input) => {
      calls.push(input);
      return { status: 'anonymous' };
    });
    const response = await k.app.request('/api/v1/whoami', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({ sessionToken: undefined, bearerToken: undefined });
  });

  it('400 AUTH_AMBIGUOUS when cookie AND bearer are both present (locked)', async () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    const response = await k.app.request('/api/v1/whoami', {
      headers: {
        cookie: 'devguard_session=abc',
        authorization: 'Bearer dgv1_secret',
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_AMBIGUOUS');
  });

  it('returns anonymous when the resolver says anonymous (unknown creds)', async () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    const response = await k.app.request('/api/v1/whoami', {
      headers: { authorization: 'Bearer dgv1_unknownvalue' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: undefined, authMethod: undefined });
  });

  it('is case-insensitive about the Bearer scheme (RFC 6750)', async () => {
    const k = kernelWith(async ({ bearerToken }) =>
      bearerToken === 'dgv1_secret'
        ? {
            status: 'authenticated',
            principal: { userId: 'user-2', authMethod: 'api_token' } as never,
          }
        : { status: 'anonymous' },
    );
    const response = await k.app.request('/api/v1/whoami', {
      headers: { authorization: 'bearer dgv1_secret' },
    });
    expect((await response.json()) as { userId: string }).toMatchObject({ userId: 'user-2' });
  });
});

describe('CP005 repository-capability route metadata (registry contract)', () => {
  it('exposes a declared capability + repositoryIdParam on the route registry', async () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    k.registerV1Route(
      'post',
      '/api/v1/repositories/:repositoryId/workflows',
      {
        rateLimitClass: 'default',
        authClass: 'required_session',
        capability: 'workflow:start',
        repositoryIdParam: 'repositoryId',
      },
      async (c) => c.json({ ok: true }),
    );
    const meta = k.routeMetadata.get('POST /api/v1/repositories/:repositoryId/workflows');
    expect(meta?.capability).toBe('workflow:start');
    expect(meta?.repositoryIdParam).toBe('repositoryId');
  });

  it('rejects a route that declares a capability without the repository id param', () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    expect(() =>
      k.registerV1Route(
        'get',
        '/api/v1/repositories/:repositoryId',
        { rateLimitClass: 'default', authClass: 'required_session', capability: 'repository:read' },
        async (c) => c.json({}),
      ),
    ).toThrow(/capability and repositoryIdParam together/);
  });

  it('rejects a route that declares a repository id param without a capability', () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    expect(() =>
      k.registerV1Route(
        'get',
        '/api/v1/repositories/:repositoryId',
        {
          rateLimitClass: 'default',
          authClass: 'required_session',
          repositoryIdParam: 'repositoryId',
        },
        async (c) => c.json({}),
      ),
    ).toThrow(/capability and repositoryIdParam together/);
  });

  it('rejects a repository-scoped route that omits BOTH capability and repositoryIdParam', () => {
    const k = kernelWith(async () => ({ status: 'anonymous' }));
    // A path with a :repositoryId segment must authorize — even if the author
    // "forgot" both fields (CP005 finding: silent authz bypass).
    expect(() =>
      k.registerV1Route(
        'get',
        '/api/v1/repositories/:repositoryId/workflows',
        { rateLimitClass: 'default', authClass: 'required_session' },
        async (c) => c.json({}),
      ),
    ).toThrow(/repository-scoped and must declare capability/);
  });

  it('502 when a capability-gated route is registered but no authorize hook is wired', async () => {
    const k = createTransportKernel({
      rateLimiter: new InMemoryRateLimiter(),
      authenticate: async (input: AuthenticateInput) =>
        input.sessionToken === 'session-1'
          ? { status: 'authenticated', principal: { userId: 'u', authMethod: 'session' } as never }
          : { status: 'anonymous' },
    });
    k.registerV1Route(
      'post',
      '/api/v1/repositories/:repositoryId/workflows',
      {
        rateLimitClass: 'default',
        authClass: 'required_session',
        capability: 'workflow:start',
        repositoryIdParam: 'repositoryId',
      },
      async (c) => c.json({ ok: true }),
    );
    const response = await k.app.request('/api/v1/repositories/r/workflows', {
      method: 'POST',
      headers: { cookie: 'devguard_session=session-1' },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTHORIZATION_UNCONFIGURED');
  });
});

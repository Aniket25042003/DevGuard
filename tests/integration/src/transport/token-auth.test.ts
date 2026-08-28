/**
 * CP004 §22/§25 — CLI/API bearer tokens over the transport kernel:
 * issue (session-required), authenticate by bearer, list (no hash leaked),
 * revoke → 401, CSRF required for cookie mutations but VALIDATED bearers skip
 * it, and cookie+bearer together → 400 AUTH_AMBIGUOUS.
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
      return `https://github.com/login/oauth/authorize?client_id=Iv1.testclient&state=${input.state}`;
    },
    async exchangeCode() {
      return { accessToken: 'token-for-c1' };
    },
    async fetchIdentity(): Promise<ExternalIdentity> {
      return {
        issuer: 'https://github.com',
        providerSubject: '1001',
        login: 'octocat',
        displayName: 'Octo Cat',
      };
    },
  };
}

function boot(): ApiContainer & ReturnType<typeof assembleApi> {
  const config = loadConfig('api', { env: { ...API_ENV } });
  const container = buildContainer(config, { ...API_ENV }, { identityProvider: fakeIdp() });
  validateReadiness(config, container.bindings);
  return Object.assign(container, assembleApi(container));
}

function extractCookie(setCookie: string | undefined, name: string): string | undefined {
  if (setCookie === undefined) return undefined;
  for (const part of setCookie.split(', ')) {
    const pair = part.split(';')[0] ?? '';
    const [key, ...rest] = pair.split('=');
    const value = rest.join('=');
    if (key === name) return decodeURIComponent(value);
  }
  return undefined;
}

interface SessionCookies {
  session: string;
  csrf: string;
}

async function loginSession(
  api: ApiContainer & ReturnType<typeof assembleApi>,
): Promise<SessionCookies> {
  const login = await api.app.request('/api/v1/auth/login');
  const state = extractCookie(login.headers.get('set-cookie') ?? undefined, 'devguard_state')!;
  const callback = await api.app.request(`/api/v1/auth/callback?code=c1&state=${state}`, {
    headers: { cookie: `devguard_state=${state}` },
    redirect: 'manual',
  });
  const setCookie: string = callback.headers.get('set-cookie') ?? '';
  return {
    session: extractCookie(setCookie, 'devguard_session')!,
    csrf: extractCookie(setCookie, 'devguard_csrf')!,
  };
}

/** Cookie mutation header set: session + CSRF pair + same-origin. */
function mutationHeaders(c: SessionCookies): Record<string, string> {
  return {
    cookie: `devguard_session=${c.session}; devguard_csrf=${c.csrf}`,
    'x-csrf-token': c.csrf,
    origin: 'http://localhost:3000',
  };
}

async function issueToken(
  api: ApiContainer & ReturnType<typeof assembleApi>,
  c: SessionCookies,
  label: string,
): Promise<{ token: string; tokenId: string }> {
  const response = await api.app.request('/api/v1/auth/tokens', {
    method: 'POST',
    headers: { ...mutationHeaders(c), 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    data: { token: string; tokenId: string; expiresAt: string };
  };
  return { token: body.data.token, tokenId: body.data.tokenId };
}

describe('CP004 CLI/API bearer tokens', () => {
  it('requires a cookie session (not another API token) to issue', async () => {
    const api = boot();
    const c = await loginSession(api);
    const { token } = await issueToken(api, c, 'ci');

    // Issuing via a bearer principal → 401 (issuance is session-only).
    const forbidden = await api.app.request('/api/v1/auth/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'again' }),
    });
    expect(forbidden.status).toBe(401);
  });

  it('issues a token once and authenticates a later bearer call', async () => {
    const api = boot();
    const c = await loginSession(api);
    const { token, tokenId } = await issueToken(api, c, 'ci');

    expect(token.startsWith('dgv1_')).toBe(true);
    expect(tokenId.length).toBeGreaterThan(0);

    const session = await api.app.request('/api/v1/auth/session', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      authenticated: boolean;
      user?: { id?: string };
    };
    expect(body.authenticated).toBe(true);
    // Token principals have no provider-login snapshot in MVP; the stable
    // userId is the authoritative identity (CP017 enriches display names).
    expect(body.user?.id).toBeDefined();
  });

  it('returns 400 AUTH_AMBIGUOUS when cookie and bearer are both present', async () => {
    const api = boot();
    const c = await loginSession(api);
    const { token } = await issueToken(api, c, 'amb');

    const response = await api.app.request('/api/v1/auth/session', {
      headers: {
        cookie: `devguard_session=${c.session}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_AMBIGUOUS');
  });

  it('rejects unknown and revoked bearers with 401 on protected routes', async () => {
    const api = boot();
    const c = await loginSession(api);
    const { token, tokenId } = await issueToken(api, c, 'revoke-me');

    // Revoked token → 401 on a required_session route.
    const revoke = await api.app.request(`/api/v1/auth/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(204);

    const after = await api.app.request(`/api/v1/auth/tokens/${tokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);

    const unknown = await api.app.request('/api/v1/auth/tokens/x', {
      method: 'DELETE',
      headers: { authorization: 'Bearer dgv1_00000000000000000000000000000000' },
    });
    expect(unknown.status).toBe(401);
  });

  it('validated bearers skip CSRF; cookie mutations still require it', async () => {
    const api = boot();
    const c = await loginSession(api);
    const first = await issueToken(api, c, 'keeper');
    const second = await issueToken(api, c, 'loser');

    // Cookie mutation WITHOUT CSRF pair → 403.
    const cookieNoCsrf = await api.app.request(`/api/v1/auth/tokens/${second.tokenId}`, {
      method: 'DELETE',
      headers: { cookie: `devguard_session=${c.session}` },
    });
    expect(cookieNoCsrf.status).toBe(403);

    // Bearer mutation WITHOUT CSRF/Origin → still allowed (credential-proof).
    const bearerDelete = await api.app.request(`/api/v1/auth/tokens/${second.tokenId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(bearerDelete.status).toBe(204);
  });

  it('never leaks the token hash or plaintext in the list response', async () => {
    const api = boot();
    const c = await loginSession(api);
    await issueToken(api, c, 'listed');

    const list = await api.app.request('/api/v1/auth/tokens', {
      headers: { authorization: `Bearer ${(await issueToken(api, c, 'reader')).token}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(Array.isArray(body.data)).toBe(true);
    for (const item of body.data) {
      expect('tokenHash' in item).toBe(false);
      expect('token' in item).toBe(false);
    }
    // Every row carries the stable id + label metadata.
    expect(body.data[0]?.tokenId).toBeDefined();
  });
});

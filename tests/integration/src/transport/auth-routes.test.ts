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

/** Scripted provider double: no network; deterministic authorize URLs. */
function fakeIdp(): IdentityProviderClient & { exchanged: string[] } {
  return {
    exchanged: [],
    buildAuthorizeUrl(input: { state: string }) {
      return `https://github.com/login/oauth/authorize?client_id=Iv1.testclient&state=${input.state}`;
    },
    async exchangeCode(input: { code: string }) {
      this.exchanged.push(input.code);
      if (input.code === 'fail') throw new Error('github_token_exchange_failed:400');
      return { accessToken: `token-for-${input.code}` };
    },
    async fetchIdentity(accessToken: string): Promise<ExternalIdentity> {
      return {
        issuer: 'https://github.com',
        providerSubject: accessToken === 'token-for-c1' ? '1001' : '2002',
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

describe('C005 auth endpoints over the transport kernel', () => {
  it('reports anonymous session summaries without 401', async () => {
    const api = boot();
    const response = await api.app.request('/api/v1/auth/session');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
    expect(response.headers.get('x-request-id')).toBeDefined();
  });

  it('starts login with a one-time state cookie and provider redirect', async () => {
    const api = boot();
    const response = await api.app.request('/api/v1/auth/login?returnTo=/repos');
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=Iv1.testclient');
    const state = extractCookie(response.headers.get('set-cookie') ?? undefined, 'devguard_state');
    expect(state).toBeDefined();
  });

  it('rejects same-site violations on returnTo (open redirect guard)', async () => {
    const api = boot();
    const response = await api.app.request('/api/v1/auth/login?returnTo=https://evil.example');
    expect(response.status).toBe(400);
  });

  it('binds state cookie to callback and issues rotated session + CSRF cookies', async () => {
    const api = boot();
    const login = await api.app.request('/api/v1/auth/login?returnTo=/dashboard');
    const state = extractCookie(login.headers.get('set-cookie') ?? undefined, 'devguard_state');
    expect(state).toBeDefined();

    const callback = await api.app.request('/api/v1/auth/callback?code=c1&state=' + String(state), {
      headers: { cookie: `devguard_state=${String(state)}` },
      redirect: 'manual',
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');
    const setCookie: string = callback.headers.get('set-cookie') ?? '';
    const sessionToken = extractCookie(setCookie, 'devguard_session');
    const csrfCookie = extractCookie(setCookie, 'devguard_csrf');
    expect(sessionToken).toBeDefined();
    expect(csrfCookie).toBeDefined();

    const session = await api.app.request('/api/v1/auth/session', {
      headers: { cookie: `devguard_session=${String(sessionToken)}` },
    });
    const body = (await session.json()) as { authenticated: boolean; user?: { id?: string } };
    expect(body.authenticated).toBe(true);
    expect(body.user?.id).toBeDefined();
  });

  it('rejects replayed callbacks with a conflict status', async () => {
    const api = boot();
    const login = await api.app.request('/api/v1/auth/login');
    const state = extractCookie(login.headers.get('set-cookie') ?? undefined, 'devguard_state');
    const first = await api.app.request(`/api/v1/auth/callback?code=c2&state=${String(state)}`, {
      headers: { cookie: `devguard_state=${String(state)}` },
      redirect: 'manual',
    });
    expect(first.status).toBe(302);
    const second = await api.app.request(`/api/v1/auth/callback?code=c2&state=${String(state)}`, {
      headers: { cookie: `devguard_state=${String(state)}` },
      redirect: 'manual',
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('fails closed when the callback state does not match the transaction cookie', async () => {
    const api = boot();
    const callback = await api.app.request(
      '/api/v1/auth/callback?code=x&state=tampered-state-token-value',
      { headers: { cookie: 'devguard_state=different-state-token-value' }, redirect: 'manual' },
    );
    expect(callback.status).toBe(400);
    const body = (await callback.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBeDefined();
  });

  it('requires CSRF for cookie-authenticated logout mutations', async () => {
    const api = boot();
    const login = await api.app.request('/api/v1/auth/login');
    const state = extractCookie(login.headers.get('set-cookie') ?? undefined, 'devguard_state');
    const callback = await api.app.request(`/api/v1/auth/callback?code=c1&state=${String(state)}`, {
      headers: { cookie: `devguard_state=${String(state)}` },
      redirect: 'manual',
    });
    const setCookie: string = callback.headers.get('set-cookie') ?? '';
    const sessionToken = extractCookie(setCookie, 'devguard_session');
    const csrfCookie = extractCookie(setCookie, 'devguard_csrf');

    // No CSRF header → rejected.
    const rejected = await api.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `devguard_session=${String(sessionToken)}; devguard_csrf=${String(csrfCookie)}`,
        origin: 'http://localhost:3000',
      },
    });
    expect(rejected.status).toBe(403);

    // With header+cookie pair and same-origin → revoked, 204, cookies cleared.
    const ok = await api.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `devguard_session=${String(sessionToken)}; devguard_csrf=${String(csrfCookie)}`,
        'x-csrf-token': String(csrfCookie),
        origin: 'http://localhost:3000',
      },
    });
    expect(ok.status).toBe(204);

    // Session is gone.
    const after = await api.app.request('/api/v1/auth/session', {
      headers: { cookie: `devguard_session=${String(sessionToken)}` },
    });
    const body = (await after.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
  });

  it('returns stable envelopes on protected routes without sessions', async () => {
    const api = boot();
    const response = await api.app.request('/api/v1/auth/logout', { method: 'POST' });
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; requestId: string; retryable: boolean };
    };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.requestId).toBe('string');
  });

  it('rate-limits repeated logins per route class within one process', async () => {
    const api = boot();
    let lastStatus = 200;
    for (let index = 0; index < 15 && lastStatus !== 429; index += 1) {
      const response = await api.app.request('/api/v1/auth/login');
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
    expect(api.app.request).toBeDefined();
  });
});

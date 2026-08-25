/**
 * C005 — The four auth endpoints (§11), thin over AuthenticationService.
 *
 * GET  /api/v1/auth/session   optional cookie → safe summary
 * GET  /api/v1/auth/login     starts OAuth+PKCE; sets one-time state cookie
 * GET  /api/v1/auth/callback  single-use transaction → rotated session cookie
 * POST /api/v1/auth/logout    CSRF-protected idempotent revocation
 */
import type { ApiContainer } from '../composition/container.js';
import {
  authCallbackQuerySchema,
  authSessionResponseSchema,
  loginQuerySchema,
} from '@devguard/api-contracts';
import { constantTimeEquals, deriveCsrfToken } from '@devguard/auth';
import { validationFailed } from '@devguard/errors';
import type { AppEnv, RegisterV1Route, RouteMetadata } from '../transport/kernel.js';

const SESSION_COOKIE = 'devguard_session';
const STATE_COOKIE = 'devguard_state';
const CSRF_COOKIE = 'devguard_csrf';

function setCookieValue(
  name: string,
  value: string,
  options: {
    maxAgeSeconds?: number;
    httpOnly?: boolean;
    path?: string;
    sameSite?: 'Lax' | 'Strict';
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  parts.push(`Max-Age=${options.maxAgeSeconds ?? 600}`);
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  // Secure is set by the reverse proxy terminator in production deployments;
  // local development origins are plain http.
  return parts.join('; ');
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function registerAuthRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
): void {
  const { config, auth } = container;

  const sessionMeta: RouteMetadata = { rateLimitClass: 'default', authClass: 'optional_session' };
  const loginMeta: RouteMetadata = { rateLimitClass: 'auth_login', authClass: 'public' };
  const callbackMeta: RouteMetadata = { rateLimitClass: 'auth_callback', authClass: 'public' };
  const logoutMeta: RouteMetadata = {
    rateLimitClass: 'auth_logout',
    authClass: 'required_session',
  };

  kernel.registerV1Route('get', '/api/v1/auth/session', sessionMeta, async (c) => {
    const principal = c.get('requestContext').principal;
    if (principal === undefined) {
      return c.json(authSessionResponseSchema.parse({ authenticated: false }));
    }
    return c.json(
      authSessionResponseSchema.parse({
        authenticated: true,
        user: { id: principal.userId, login: principal.providerSubject },
      }),
    );
  });

  kernel.registerV1Route('get', '/api/v1/auth/login', loginMeta, async (c) => {
    const rawReturnTo: string | undefined = c.req.query('returnTo');
    const queryInput: { returnTo?: string } = {};
    if (rawReturnTo !== undefined) queryInput['returnTo'] = rawReturnTo;
    const query = loginQuerySchema.safeParse(queryInput);
    if (!query.success) {
      throw validationFailed([
        { path: 'returnTo', constraint: 'must be a same-site relative path' },
      ]);
    }
    const startedInput: { returnTo?: string } = {};
    if (query.data.returnTo !== undefined) startedInput['returnTo'] = query.data.returnTo;
    const started = await auth.startLogin(startedInput);
    c.header(
      'set-cookie',
      setCookieValue(STATE_COOKIE, started.stateToken, { maxAgeSeconds: 600 }),
    );
    return c.redirect(started.authorizeUrl, 302);
  });

  kernel.registerV1Route('get', '/api/v1/auth/callback', callbackMeta, async (c) => {
    const queryResult = authCallbackQuerySchema.safeParse({
      ...(c.req.query('code') !== undefined ? { code: c.req.query('code') } : {}),
      ...(c.req.query('state') !== undefined ? { state: c.req.query('state') } : {}),
      ...(c.req.query('error') !== undefined ? { error: c.req.query('error') } : {}),
      ...(c.req.query('error_description') !== undefined
        ? { error_description: c.req.query('error_description') }
        : {}),
    });
    if (!queryResult.success) {
      throw validationFailed([{ path: 'callback', constraint: 'invalid callback parameters' }]);
    }

    // Bind the presented state to the one-time cookie value.
    const cookieState = readCookie(c, STATE_COOKIE);
    if (
      queryResult.data.error !== undefined ||
      queryResult.data.code === undefined ||
      queryResult.data.state === undefined ||
      cookieState === undefined ||
      !constantTimeEquals(cookieState, queryResult.data.state)
    ) {
      throw validationFailed([{ path: 'state', constraint: 'state mismatch or provider error' }]);
    }

    const completed = await auth.completeLogin({
      code: queryResult.data.code,
      stateToken: queryResult.data.state,
    });

    const csrfToken = deriveCsrfToken(
      completed.sessionIdHash,
      completed.sessionIdHash + config.environment,
    );
    c.header(
      'set-cookie',
      [
        setCookieValue(SESSION_COOKIE, completed.sessionToken, {
          maxAgeSeconds:
            Math.floor(Date.parse(completed.expiresAt) / 1000) - Math.floor(Date.now() / 1000),
        }),
        setCookieValue(CSRF_COOKIE, csrfToken, { maxAgeSeconds: 86_400, httpOnly: false }),
        clearCookie(STATE_COOKIE),
      ].join(', '),
    );
    return c.redirect(completed.returnToPath, 302);
  });

  kernel.registerV1Route('post', '/api/v1/auth/logout', logoutMeta, async (c) => {
    const sessionToken = readCookie(c, SESSION_COOKIE);
    if (sessionToken === undefined) {
      throw validationFailed([{ path: 'session', constraint: 'no session presented' }]);
    }
    await auth.revokeIfExists(sessionToken);
    c.header('set-cookie', `${clearCookie(SESSION_COOKIE)}, ${clearCookie(CSRF_COOKIE)}`);
    return c.body(null, 204);
  });
}

function readCookie(
  c: { req: { header(name: string): string | undefined } },
  name: string,
): string | undefined {
  const header = c.req.header('cookie');
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export type AuthRouteEnv = AppEnv;

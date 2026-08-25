/**
 * C005 — Request context, route metadata, and the TransportKernel.
 *
 * Fixed middleware order (never reorder):
 *   request-id → body limits/raw-body → security headers → authentication →
 *   per-route gates (auth class + rate class) → controller → safe errors.
 * The kernel contains no domain logic; controllers call application ports.
 */
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { normalizeError, presentHttpError } from '@devguard/errors';
import type { Principal } from '@devguard/auth';

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly principal?: Principal;
  /** Coarse client class derived from IP — never raw addresses. */
  readonly ipClass: string;
}

export type AppEnv = {
  Variables: {
    requestContext: RequestContext;
    /** Raw body captured for signature-verified webhook routes (C075). */
    rawBody?: ArrayBuffer;
  };
};

export type RouteHandler = (c: Context<AppEnv>) => Promise<Response> | Response;

/** Route classes drive rate limits and auth requirements. */
export type RateLimitClass = 'auth_login' | 'auth_callback' | 'auth_logout' | 'default';
export type AuthClass = 'public' | 'optional_session' | 'required_session';

export interface RouteMetadata {
  readonly rateLimitClass: RateLimitClass;
  readonly authClass: AuthClass;
}

export interface RateLimiterPort {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export const RATE_LIMITS: Readonly<
  Record<RateLimitClass, { limit: number; windowSeconds: number }>
> = {
  auth_login: { limit: 10, windowSeconds: 60 },
  auth_callback: { limit: 30, windowSeconds: 60 },
  auth_logout: { limit: 15, windowSeconds: 60 },
  default: { limit: 300, windowSeconds: 60 },
};

export function createRequestContext(ipClass: string): RequestContext {
  return {
    requestId: randomUUID(),
    startedAt: Date.now(),
    ipClass,
  };
}

function readCookie(c: Context<AppEnv>, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Build the /api/v1 kernel shell. `registerV1Route` is the only way in. */
export function createTransportKernel(input: {
  readonly rateLimiter: RateLimiterPort;
  readonly authenticate: (sessionToken: string | undefined) => Promise<Principal | undefined>;
}): {
  app: Hono<AppEnv>;
  registerV1Route: RegisterV1Route;
  routeMetadata: ReadonlyMap<string, RouteMetadata>;
} {
  const app = new Hono<AppEnv>();
  const registry = new Map<string, RouteMetadata>();

  // 1) request-id + context first
  app.use('/api/v1/*', async (c, next) => {
    c.set(
      'requestContext',
      createRequestContext(c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'),
    );
    await next();
    c.header('x-request-id', c.get('requestContext').requestId);
    return undefined;
  });

  // 2) body limits / raw-body capture
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/webhooks/')) {
      c.set('rawBody', await c.req.raw.arrayBuffer());
    }
    const contentLength = Number.parseInt(c.req.header('content-length') ?? '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
      return fail(c, 413, 'VALIDATION_FAILED', 'Payload too large.');
    }
    await next();
    return undefined;
  });

  // 3) security headers
  app.use('/api/v1/*', async (c, next) => {
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('cache-control', 'no-store');
    await next();
    return undefined;
  });

  // 4) authentication before controllers
  app.use('/api/v1/*', async (c, next) => {
    const sessionToken = readCookie(c, 'devguard_session');
    const principal = await input.authenticate(sessionToken);
    if (principal !== undefined) {
      c.set('requestContext', { ...c.get('requestContext'), principal });
    }
    await next();
    return undefined;
  });

  // 5) per-route gates + safe error mapping
  const registerV1Route: RegisterV1Route = (method, path, metadata, handler) => {
    const key = `${method.toUpperCase()} ${path}`;
    if (registry.has(key)) {
      throw new Error(`Duplicate route registration: ${key}`);
    }
    registry.set(key, metadata);
    app.on(method, path, async (c) => {
      const context = c.get('requestContext');
      if (metadata.authClass === 'required_session' && context.principal === undefined) {
        return fail(c, 401, 'UNAUTHENTICATED', 'Authentication required.');
      }
      const limits = RATE_LIMITS[metadata.rateLimitClass];
      const verdict = await input.rateLimiter.consume(
        `${metadata.rateLimitClass}:${context.ipClass}`,
      );
      if (!verdict.allowed) {
        void limits;
        c.header('retry-after', String(verdict.retryAfterSeconds));
        return fail(c, 429, 'RATE_LIMITED', 'Too many requests.');
      }
      try {
        return await handler(c);
      } catch (error) {
        const presented = presentHttpError(normalizeError(error), context.requestId);
        return c.json(
          presented.body as unknown as Record<string, unknown>,
          presented.status as 400,
        );
      }
    });
  };

  return { app, registerV1Route, routeMetadata: registry };
}

export type RegisterV1Route = (
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: `/api/v1${string}`,
  metadata: RouteMetadata,
  handler: RouteHandler,
) => void;

function fail(c: Context<AppEnv>, status: number, code: string, message: string): Response {
  return c.json(
    { error: { code, message, requestId: c.get('requestContext').requestId, retryable: false } },
    status as 400,
  );
}

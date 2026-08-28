/**
 * C005 — Request context, route metadata, and the TransportKernel.
 *
 * Fixed middleware order (never reorder):
 *   request-id → top-level error boundary → body limits / bounded raw-body →
 *   security headers → authentication → per-route gates → controller.
 *
 * Security notes:
 * - Client IP class ignores X-Forwarded-For unless a trusted proxy is
 *   explicitly configured (C094 hardens further).
 * - Webhook raw bodies are captured through a bounded streaming reader that
 *   aborts as soon as the cap is exceeded, independent of Content-Length.
 */
import { Hono, type Context } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeError, presentHttpError } from '@devguard/errors';
import type { Principal } from '@devguard/auth';
import type { RepositoryCapability } from '@devguard/authorization';

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly principal?: Principal;
  /** Coarse pseudonymous client class — never a raw IP address. */
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

/**
 * Credentials present on a request. The kernel extracts the session cookie and
 * a syntactically-valid `Authorization: Bearer` value; the injected
 * `authenticate` resolver decides which (never both — the kernel rejects
 * ambiguity before it is ever consulted).
 */
export interface AuthenticateInput {
  readonly sessionToken?: string | undefined;
  readonly bearerToken?: string | undefined;
}

/**
 * Outcome of authentication. `ambiguous` means both a cookie and a bearer were
 * presented together (CP004 §11 locked → 400 AUTH_AMBIGUOUS). `authenticated`
 * is mutually exclusive with `anonymous`.
 */
export type AuthResolution =
  | { readonly status: 'authenticated'; readonly principal: Principal }
  | { readonly status: 'anonymous' }
  | { readonly status: 'ambiguous' };

/** Route classes drive rate limits and auth requirements. */
export type RateLimitClass =
  'auth_login' | 'auth_callback' | 'auth_logout' | 'auth_token_issue' | 'default';
export type AuthClass = 'public' | 'optional_session' | 'required_session';

export interface RouteMetadata {
  readonly rateLimitClass: RateLimitClass;
  readonly authClass: AuthClass;
  /**
   * CP005 — repository capability required for this route. When declared, the
   * route MUST also declare `repositoryIdParam` (the path param holding the
   * repository id), enforced at registration time. The kernel runs the injected
   * `authorize` gate after authentication and before the controller. Routes
   * without a single repository id (lists, health, auth) do not declare it.
   */
  readonly capability?: RepositoryCapability | undefined;
  /** Path parameter (e.g. `repositoryId`) that carries the repository id. */
  readonly repositoryIdParam?: string | undefined;
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
  // Token issuance is gated harder than ordinary reads: a leaked page issues
  // no tokens, and each token is a full-account credential (CP004 §17/§27).
  auth_token_issue: { limit: 5, windowSeconds: 60 },
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

/**
 * Extract a syntactically-valid `Authorization: Bearer <token>` value, or
 * `undefined`. The `Bearer` scheme is case-insensitive (RFC 6750). A header
 * that is present but not a valid Bearer is treated as absent for bearer-based
 * auth — never an error and never ambiguous against a cookie.
 */
function readBearerToken(c: Context<AppEnv>): string | undefined {
  const header = c.req.header('authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return undefined;
  const token = match[1]?.trim() ?? '';
  return token.length === 0 ? undefined : token;
}

/** Coarse pseudonymous client class — never a raw IP address. */
function clientIpClass(headerValue: string | undefined, trustedProxy: boolean): string {
  if (!trustedProxy || headerValue === undefined || headerValue.length === 0) {
    // Without a configured trusted proxy every client shares one class:
    // attacker-controlled headers can neither differentiate nor exhaust keys.
    return 'direct';
  }
  const firstHop = headerValue.split(',')[0]?.trim() ?? '';
  if (firstHop.length === 0 || firstHop.length > 45) return 'direct';
  return `proxied:${createHash('sha256').update(firstHop).digest('hex').slice(0, 16)}`;
}

export class PayloadTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`payload exceeds ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Bounded streaming capture for webhook raw bytes. Aborts as soon as the cap
 * is exceeded — independent of Content-Length, which may be absent or lied
 * about. Never buffers an unbounded request before rejecting it.
 */
async function readBoundedRawBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const body = request.body;
  if (body === null) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Authorize hook type export for the authorize hole. */
export type AuthorizeHook = (
  c: Context<AppEnv>,
  capability: RepositoryCapability,
  repositoryId: string,
) => Promise<void>;

/** Build the /api/v1 kernel shell. `registerV1Route` is the only way in. */
export function createTransportKernel(input: {
  readonly rateLimiter: RateLimiterPort;
  readonly authenticate: (input: AuthenticateInput) => Promise<AuthResolution>;
  /**
   * CP005 — invoked after authentication and before the controller for any
   * route that declares a `capability` + `repositoryIdParam`. Missing hook or
   * missing principal at a gated route fails closed (502/401 respectively).
   */
  readonly authorize?: AuthorizeHook | undefined;
  /** From config (default false): trust X-Forwarded-For for rate-limit keys. */
  readonly trustedProxy?: boolean | undefined;
  /** Webhook raw-body cap in bytes (default 1 MiB). */
  readonly webhookMaxBodyBytes?: number | undefined;
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
      createRequestContext(
        clientIpClass(c.req.header('x-forwarded-for'), input.trustedProxy === true),
      ),
    );
    await next();
    c.header('x-request-id', c.get('requestContext').requestId);
    return undefined;
  });

  // 2) top-level error boundary: any middleware failure (session-store outage,
  //    rate-limiter crash, bounded-body abort) still yields the stable
  //    envelope with the request id attached by the outer header hook above.
  app.use('/api/v1/*', async (c, next) => {
    try {
      await next();
      return undefined;
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return fail(c, 413, 'VALIDATION_FAILED', 'Payload too large.');
      }
      const presented = presentHttpError(normalizeError(error), c.get('requestContext').requestId);
      return c.json(presented.body as unknown as Record<string, unknown>, presented.status as 500);
    }
  });

  // 3) body limits / bounded raw-body capture
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/webhooks/')) {
      c.set('rawBody', await readBoundedRawBody(c.req.raw, input.webhookMaxBodyBytes ?? 1_048_576));
      return next();
    }
    const contentLength = Number.parseInt(c.req.header('content-length') ?? '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
      return fail(c, 413, 'VALIDATION_FAILED', 'Payload too large.');
    }
    await next();
    return undefined;
  });

  // 4) security headers
  app.use('/api/v1/*', async (c, next) => {
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('cache-control', 'no-store');
    await next();
    return undefined;
  });

  // 5) authentication before controllers (cookie OR bearer, never both)
  app.use('/api/v1/*', async (c, next) => {
    const sessionToken = readCookie(c, 'devguard_session');
    const bearerToken = readBearerToken(c);
    // Locked (CP004 §11): presenting BOTH a cookie and a bearer is ambiguous.
    if (sessionToken !== undefined && bearerToken !== undefined) {
      return fail(
        c,
        400,
        'AUTH_AMBIGUOUS',
        'Present either a session or a bearer token, not both.',
      );
    }
    const resolution = await input.authenticate({ sessionToken, bearerToken });
    if (resolution.status === 'ambiguous') {
      return fail(
        c,
        400,
        'AUTH_AMBIGUOUS',
        'Present either a session or a bearer token, not both.',
      );
    }
    if (resolution.status === 'authenticated') {
      c.set('requestContext', {
        ...c.get('requestContext'),
        principal: resolution.principal,
      });
    }
    await next();
    return undefined;
  });

  // 6) per-route gates + safe error mapping for controller failures
  const registerV1Route: RegisterV1Route = (method, path, metadata, handler) => {
    const key = `${method.toUpperCase()} ${path}`;
    if (registry.has(key)) {
      throw new Error(`Duplicate route registration: ${key}`);
    }
    // CP005: a repo-scoped route declares BOTH a capability and the path param
    // that carries the repository id — never one without the other. Enforced at
    // composition time so a future route can't silently skip authorization.
    if ((metadata.capability === undefined) !== (metadata.repositoryIdParam === undefined)) {
      throw new Error(
        `Route ${key} must declare capability and repositoryIdParam together (CP005).`,
      );
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
        // CP005: run the repository-authorization gate before the controller.
        if (metadata.capability !== undefined && metadata.repositoryIdParam !== undefined) {
          if (context.principal === undefined) {
            return fail(c, 401, 'UNAUTHENTICATED', 'Authentication required.');
          }
          if (input.authorize === undefined) {
            return fail(
              c,
              502,
              'AUTHORIZATION_UNCONFIGURED',
              'Repository authorization is not wired.',
            );
          }
          const repositoryId = c.req.param(metadata.repositoryIdParam);
          if (repositoryId === undefined || repositoryId.length === 0) {
            return fail(c, 400, 'VALIDATION_FAILED', 'Repository id is required.');
          }
          await input.authorize(c, metadata.capability, repositoryId);
        }
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

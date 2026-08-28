/**
 * C005 — API application assembly: kernel + CSRF/origin + routes.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import { createTransportKernel, type AppEnv, type RouteMetadata } from './transport/kernel.js';
import { InMemoryRateLimiter } from './transport/rate-limit.js';
import { enforceCsrfAndOrigin } from './transport/security.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerSessionRoutes, type SessionPort } from './routes/session.routes.js';
import { registerApprovalRoutes, type ApprovalPort } from './routes/approval.routes.js';

/** In-memory session/event projection until C037/C038 wiring. */
const VolatileSessions: SessionPort = {
  async get(_sessionId: string, _userId: string) {
    return undefined;
  },
  async events(_sessionId: string, _userId: string, _limit: number) {
    return [];
  },
};

/** In-memory approval projection/resolution until C070/C035 wiring. */
const VolatileApprovals: ApprovalPort = {
  async listFor(_runId: string) {
    return [];
  },
  async resolve(
    _runId: string,
    _approvalId: string,
    _resolution: 'approved' | 'rejected',
    _userId: string,
  ) {
    return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'no approval store wired' };
  },
};

export interface AssembledApi {
  readonly app: Hono<AppEnv>;
  readonly routeMetadata: ReadonlyMap<string, RouteMetadata>;
}

export function assembleApi(container: ApiContainer): AssembledApi {
  const kernel = createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: (sessionToken) => container.auth.resolvePrincipal(sessionToken),
    trustedProxy: container.config.trustedProxyEnabled,
    webhookMaxBodyBytes: container.config.limits.webhookMaxBodyBytes,
  });

  // 4.5) CSRF + same-origin for state-changing requests (after authentication,
  //      before controllers; webhooks exempt inside the check).
  kernel.app.use('/api/v1/*', async (c, next) => {
    const rejection = enforceCsrfAndOrigin(c, {
      publicOrigin: container.config.publicOrigin,
    });
    if (rejection !== undefined) return rejection;
    await next();
    return undefined;
  });

  registerAuthRoutes(kernel, container);

  // C068 session/event routes, C070 approval routes.
  registerSessionRoutes(kernel, VolatileSessions);
  registerApprovalRoutes(kernel, VolatileApprovals);

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

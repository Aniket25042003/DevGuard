/**
 * C005 — API application assembly: kernel + CSRF/origin + routes.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import { createTransportKernel, type AppEnv, type RouteMetadata } from './transport/kernel.js';
import { InMemoryRateLimiter } from './transport/rate-limit.js';
import { enforceCsrfAndOrigin } from './transport/security.js';
import { registerAuthRoutes } from './routes/auth.routes.js';

export interface AssembledApi {
  readonly app: Hono<AppEnv>;
  readonly routeMetadata: ReadonlyMap<string, RouteMetadata>;
}

export function assembleApi(container: ApiContainer): AssembledApi {
  const kernel = createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: (sessionToken) => container.auth.resolvePrincipal(sessionToken),
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

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

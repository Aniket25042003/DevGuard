/**
 * C005 — API application assembly: kernel + CSRF/origin + routes.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import { createTransportKernel, type AppEnv, type RouteMetadata } from './transport/kernel.js';
import { InMemoryRateLimiter } from './transport/rate-limit.js';
import { enforceCsrfAndOrigin } from './transport/security.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import {
  registerRepositoryRoutes,
  registerWebhookRoutes,
  verifyGithubHmac,
  type RepositoryCatalogPort,
  type WebhookAcceptancePort,
} from './routes/github.routes.js';

/** Volatile webhook acceptance until C022 ingress wiring lands. */
class VolatileWebhookAcceptance implements WebhookAcceptancePort {
  readonly claimed = new Map<string, number>();
  private readonly replayWindowMs = 5 * 60 * 1000;
  async accept(input: {
    deliveryId: string;
    event: string;
    payloadJson: string;
    headers: { signature: string };
  }): Promise<{ accepted: boolean; replay?: boolean }> {
    void input.event;
    void input.payloadJson;
    void input.headers;
    const now = Date.now();
    for (const [deliveryId, claimedAt] of this.claimed) {
      if (now - claimedAt >= this.replayWindowMs) this.claimed.delete(deliveryId);
    }
    const replay = this.claimed.has(input.deliveryId);
    this.claimed.set(input.deliveryId, now);
    return { accepted: true, replay };
  }
}

/** No durable repo linkage yet (C009/C014/C018): truthful empty catalog. */
const VolatileRepositoryCatalog: RepositoryCatalogPort = {
  async listFor(_userId: string) {
    return [];
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

  // C074 health, C065 repository catalog, C075 GitHub webhook acceptance.
  registerHealthRoutes(kernel, [
    {
      name: 'kernel',
      critical: true,
      check: async () => ({ ok: true }),
    },
  ]);
  registerWebhookRoutes(
    kernel,
    new VolatileWebhookAcceptance(),
    () => container.webhookSecret,
    verifyGithubHmac,
  );
  registerRepositoryRoutes(kernel, VolatileRepositoryCatalog);

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

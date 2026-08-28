/**
 * C005 — API application assembly: kernel + CSRF/origin + routes.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import { createTransportKernel, type AppEnv, type RouteMetadata } from './transport/kernel.js';
import { InMemoryRateLimiter } from './transport/rate-limit.js';
import { enforceCsrfAndOrigin } from './transport/security.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerArtifactRoutes, type ArtifactPort } from './routes/artifact.routes.js';
import { registerAuditRoutes, type AuditPort } from './routes/audit.routes.js';
import { registerFindingsRoutes, type FindingsPort } from './routes/findings.routes.js';

/** In-memory safe-artifact/audit/findings projections until C044/C064/C051. */
const VolatileArtifacts: ArtifactPort = {
  async listFor(_runId: string) {
    return [];
  },
  async getSafe(_id: string) {
    return undefined;
  },
};
const VolatileAudit: AuditPort = {
  async list(_userId: string) {
    // No hash-chain verifier is composed for this volatile adapter.  Never
      // present an unverified projection as integrity-verified.
      return { verified: false, rows: [] };
  },
};
const VolatileFindings: FindingsPort = {
  async listFor(_runId: string) {
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

  // C071 safe artifacts, C072 audit, C073 security findings.
  registerArtifactRoutes(kernel, VolatileArtifacts);
  registerAuditRoutes(kernel, VolatileAudit);
  registerFindingsRoutes(kernel, VolatileFindings);

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

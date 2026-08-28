/**
 * C005/CP002 — API application assembly: kernel + CSRF/origin + routes.
 *
 * Every port is read from `ApiContainer.bindings`; no route creates or owns a
 * store, and no volatile adapter is ever defined here (CP002 §23/§8). The
 * container validates binding safety before assembly; this file only wires.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import { createTransportKernel, type AppEnv, type RouteMetadata } from './transport/kernel.js';
import { InMemoryRateLimiter } from './transport/rate-limit.js';
import { enforceCsrfAndOrigin } from './transport/security.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerApprovalRoutes } from './routes/approval.routes.js';
import {
  registerPolicyRoutes,
  registerWorkflowRoutes,
  registerCommandRoutes,
} from './routes/workflow.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import {
  registerRepositoryRoutes,
  registerWebhookRoutes,
  verifyGithubHmac,
} from './routes/github.routes.js';
import { registerArtifactRoutes } from './routes/artifact.routes.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import { registerFindingsRoutes } from './routes/findings.routes.js';

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
  registerArtifactRoutes(kernel, container.bindings.artifacts);
  registerAuditRoutes(kernel, container.bindings.audit);
  registerFindingsRoutes(kernel, container.bindings.findings);

  // C068 session/event routes, C070 approval routes.
  registerSessionRoutes(kernel, container.bindings.sessionEvents);
  registerApprovalRoutes(kernel, container.bindings.approvals);

  // C066 policies summary, C067 workflow launch/status, C069 command catalog.
  registerPolicyRoutes(kernel, container.bindings.policies);
  registerWorkflowRoutes(kernel, container.bindings.workflows, container.bindings.workflows);
  registerCommandRoutes(kernel, container.bindings.workflows);

  // C074 health, C065 repository catalog, C075 GitHub webhook acceptance.
  registerHealthRoutes(kernel, [
    {
      name: 'kernel',
      critical: true,
      check: async () => ({ ok: true }),
    },
    ...(container.pool === undefined
      ? []
      : [
          {
            name: 'database',
            critical: true,
            check: async () => {
              const health = await container.pool!.health();
              return { ok: health.ok };
            },
          } as const,
        ]),
  ]);
  registerWebhookRoutes(
    kernel,
    container.bindings.webhooks,
    () => container.webhookSecret,
    verifyGithubHmac,
  );
  registerRepositoryRoutes(kernel, container.bindings.repositoryCatalog);

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

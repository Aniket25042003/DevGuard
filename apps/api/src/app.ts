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
import { requireCapability } from './authorization/http.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerApiTokenRoutes } from './routes/auth-tokens.routes.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerApprovalRoutes } from './routes/approval.routes.js';
import {
  registerCommandRoutes,
  registerPolicyRoutes,
  registerWorkflowRoutes,
} from './routes/workflow.routes.js';
import { registerRepositoryCommandRoutes } from './routes/commands.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import {
  registerRepositoryRoutes,
  registerWebhookRoutes,
  verifyGithubHmac,
} from './routes/github.routes.js';
import { registerArtifactRoutes } from './routes/artifact.routes.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import {
  registerFindingsRoutes,
  registerFindingsRemediationRoutes,
} from './routes/findings.routes.js';
import { registerDiagnosticsRoutes, type PreflightStatus } from './routes/diagnostics.routes.js';
import { registerWebSurfaceRoutes } from './routes/web-surface.routes.js';
import { registerRepositoryTargetRoutes } from './routes/repository-targets.routes.js';

/** CP015 (C074) — dependency preflight from the container config (fail closed). */
function preflightStatus(container: ApiContainer): PreflightStatus {
  const cfg = container.config;
  const real = (ref?: { name?: string }): boolean =>
    ref !== undefined && ref.name !== undefined && !ref.name.startsWith('<');
  const trueforgeEnabled = cfg.features.trueforgeIntegrationEnabled.value;
  const sandboxEnabled = cfg.features.sandboxExecutionEnabled.value;
  return {
    database: real(cfg.databaseUrlRef),
    redis: real(cfg.redisUrlRef),
    trueforge: trueforgeEnabled && cfg.trueforge !== undefined,
    sandbox: sandboxEnabled && trueforgeEnabled && cfg.trueforge !== undefined,
    github: cfg.github !== undefined,
  };
}

export interface AssembledApi {
  readonly app: Hono<AppEnv>;
  readonly routeMetadata: ReadonlyMap<string, RouteMetadata>;
}

export function assembleApi(container: ApiContainer): AssembledApi {
  const kernel = createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async ({ sessionToken, bearerToken }) => {
      // CP004: a bearer is resolved against the API-token store; a cookie is
      // resolved against sessions. Never both — the kernel already rejects the
      // ambiguous combination with 400 AUTH_AMBIGUOUS before calling us.
      if (bearerToken !== undefined) {
        const principal = await container.apiTokens.authenticate(bearerToken);
        return principal !== undefined
          ? { status: 'authenticated', principal }
          : { status: 'anonymous' };
      }
      const principal = await container.auth.resolvePrincipal(sessionToken);
      return principal !== undefined
        ? { status: 'authenticated', principal }
        : { status: 'anonymous' };
    },
    authorize: requireCapability(container.authorizer),
    trustedProxy: container.config.trustedProxyEnabled,
    webhookMaxBodyBytes: container.config.limits.webhookMaxBodyBytes,
  });

  // 4.5) CSRF + same-origin for state-changing requests (after authentication,
  //      before controllers; webhooks exempt inside the check). A validated
  //      bearer skips both gates (CP004 §6), cookie sessions keep them.
  kernel.app.use('/api/v1/*', async (c, next) => {
    const rejection = enforceCsrfAndOrigin(c, {
      publicOrigin: container.config.publicOrigin,
      mutationsViaBearer: c.get('requestContext').principal?.authMethod === 'api_token',
    });
    if (rejection !== undefined) return rejection;
    await next();
    return undefined;
  });

  registerAuthRoutes(kernel, container);
  registerApiTokenRoutes(kernel, container);

  // C071 safe artifacts, C072 audit, C073 security findings.
  registerArtifactRoutes(kernel, container.bindings.artifacts);
  registerAuditRoutes(kernel, container.bindings.audit);
  registerFindingsRoutes(kernel, container.bindings.findings);
  registerFindingsRemediationRoutes(kernel, async (input) => ({
    ok: false,
    code: 'COMMAND_UNKNOWN',
    detail: `no remediation command registered for finding ${input.findingId} (user ${input.userId})`,
  }));

  // C068 session/event routes, C070 approval routes.
  registerSessionRoutes(kernel, container.bindings.sessionEvents);
  registerApprovalRoutes(kernel, container.bindings.approvals);
  registerDiagnosticsRoutes(kernel, {
    preflight: preflightStatus(container),
    runs: async (input) => container.workflowQueries.listRuns(input),
  });

  // C066 policies summary, C067 workflow start/list/get/cancel (durable).
  registerPolicyRoutes(kernel, container);
  registerWorkflowRoutes(kernel, container);
  registerCommandRoutes(kernel, container.bindings.workflows);
  // CP006: repo-scoped command catalog + submit (shared command bus).
  registerRepositoryCommandRoutes(kernel, container);

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
    ...(container.objectStore?.probe === undefined
      ? []
      : [
          {
            name: 'artifact-storage',
            critical: true,
            check: async () => ({ ok: await container.objectStore!.probe!() }),
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
  registerWebSurfaceRoutes(kernel, container, container.bindings.approvals);
  registerRepositoryTargetRoutes(kernel, container);

  return { app: kernel.app, routeMetadata: kernel.routeMetadata };
}

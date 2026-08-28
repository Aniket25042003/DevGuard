/**
 * C005 — API application assembly: kernel + CSRF/origin + routes.
 */
import { type Hono } from 'hono';
import type { ApiContainer } from './composition/container.js';
import type { WorkflowStatus } from '@devguard/contracts';
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
  type PolicySummaryPort,
  type WorkflowLaunchPort,
  type WorkflowStatusPort,
  type CommandCatalogPort,
} from './routes/workflow.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import {
  registerRepositoryRoutes,
  registerWebhookRoutes,
  verifyGithubHmac,
  type RepositoryCatalogPort,
  type WebhookAcceptancePort,
} from './routes/github.routes.js';
import { registerArtifactRoutes, type ArtifactPort } from './routes/artifact.routes.js';
import { registerAuditRoutes, type AuditPort } from './routes/audit.routes.js';
import { registerFindingsRoutes, type FindingsPort } from './routes/findings.routes.js';

/** In-memory safe-artifact/audit/findings projections until C044/C064/C051 wiring. */
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
    // No hash-chain verifier is composed for this volatile adapter. Never
    // present an unverified projection as integrity-verified.
    return { verified: false, rows: [] };
  },
};
const VolatileFindings: FindingsPort = {
  async listFor(_runId: string) {
    return [];
  },
};

/** No durable policy store yet (C026/C030): safe empty summary. */
const VolatilePolicySummaries: PolicySummaryPort = {
  async summaryFor(_userId: string) {
    return [];
  },
};

/** In-memory workflow launch/status/command projection until C046/C058 wiring. */
class VolatileWorkflowService
  implements WorkflowLaunchPort, WorkflowStatusPort, CommandCatalogPort
{
  readonly runs = new Map<
    string,
    {
      runId: string;
      userId: string;
      state: WorkflowStatus;
      workflowType: string;
      version: string;
      idempotencyKey: string;
      input: unknown;
    }
  >();
  private counter = 0;

  async launch(
    input: { workflowType: string; version: string; idempotencyKey: string; input: unknown },
    userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  > {
    const existing = [...this.runs.values()].find(
      (r) => r.userId === userId && r.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        existing.workflowType !== input.workflowType ||
        existing.version !== input.version ||
        JSON.stringify(existing.input) !== JSON.stringify(input.input)
      ) {
        return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', detail: 'Idempotency key was reused.' };
      }
      return { ok: true, runId: existing.runId, replayed: true };
    }
    this.counter += 1;
    const runId = crypto.randomUUID();
    this.runs.set(runId, {
      runId,
      userId,
      state: 'queued',
      workflowType: input.workflowType,
      version: input.version,
      idempotencyKey: input.idempotencyKey,
      input: input.input,
    });
    return { ok: true, runId, replayed: false };
  }

  async statusOf(
    runId: string,
    userId: string,
  ): Promise<{ runId: string; state: string } | undefined> {
    const run = this.runs.get(runId);
    return run !== undefined && run.userId === userId ? { runId, state: run.state } : undefined;
  }

  async commandsOf(_runId: string, _userId: string) {
    return [];
  }
}

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

  // C071 safe artifacts, C072 audit, C073 security findings.
  registerArtifactRoutes(kernel, VolatileArtifacts);
  registerAuditRoutes(kernel, VolatileAudit);
  registerFindingsRoutes(kernel, VolatileFindings);

  // C068 session/event routes, C070 approval routes.
  registerSessionRoutes(kernel, container.bindings.sessionEvents);
  registerApprovalRoutes(kernel, container.bindings.approvals);

  // C066 policies summary, C067 workflow launch/status, C069 command catalog.
  const volatileWorkflows = new VolatileWorkflowService();
  registerPolicyRoutes(kernel, VolatilePolicySummaries);
  registerWorkflowRoutes(kernel, volatileWorkflows, volatileWorkflows);
  registerCommandRoutes(kernel, volatileWorkflows);

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

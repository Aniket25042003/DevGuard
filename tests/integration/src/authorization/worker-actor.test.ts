import { describe, expect, it } from 'vitest';
import { buildWorkerContainer } from '@devguard/worker';
import type { WorkerConfigSnapshot } from '@devguard/config';
import type { AuthorizationQueryShape } from '@devguard/authorization';

function workerConfig(): WorkerConfigSnapshot {
  return {
    processKind: 'worker',
    environment: 'test',
    loadedAt: new Date(0).toISOString(),
    hash: 'test-hash',
    warnings: [],
    features: {
      githubWritesEnabled: { key: 'githubWritesEnabled', value: false, source: 'default' },
      trueforgeIntegrationEnabled: {
        key: 'trueforgeIntegrationEnabled',
        value: false,
        source: 'default',
      },
      sandboxExecutionEnabled: { key: 'sandboxExecutionEnabled', value: false, source: 'default' },
      webhookIngressEnabled: { key: 'webhookIngressEnabled', value: false, source: 'default' },
      approvalExecutionEnabled: {
        key: 'approvalExecutionEnabled',
        value: false,
        source: 'default',
      },
      devNoAuthMode: { key: 'devNoAuthMode', value: false, source: 'default' },
    },
    databaseUrlRef: { name: 'DATABASE_URL' },
    redisUrlRef: { name: 'REDIS_URL' },
    retention: { auditDays: 365, workflowEventDays: 90, artifactDays: 30, transcriptDays: 30 },
    limits: { webhookMaxBodyBytes: 1_048_576, maxActiveRunsPerRepository: 3 },
    observability: { logLevel: 'info' },
    artifacts: { driver: 'local', localDir: '.data/artifacts' },
  };
}

describe('C006 worker composition (system actors only)', () => {
  const container = buildWorkerContainer(workerConfig());

  it('denies system actors without a run binding for run-scoped capabilities', async () => {
    const query: AuthorizationQueryShape = {
      principal: { kind: 'system', serviceId: 'worker.approval-resume', binding: {} },
      repositoryId: crypto.randomUUID(),
      capability: 'workflow:cancel',
    };
    const result = await container.authorizer.authorize(query);
    expect(result.effect).toBe('deny');
    expect(result.reasonCode).toBe('system_actor_missing_run_binding');
  });

  it('allows scoped system actors with a matching binding (linkage permitting)', async () => {
    const repositoryId = crypto.randomUUID();
    const query: AuthorizationQueryShape = {
      principal: {
        kind: 'system',
        serviceId: 'worker.approval-resume',
        binding: { workflowRunId: 'run-1' },
      },
      repositoryId,
      capability: 'workflow:cancel',
      context: { workflowRunId: 'run-1' },
    };
    // Actor scope passes; the missing durable linkage (C009) fails closed.
    let thrown: string | undefined;
    try {
      await container.authorizer.authorize(query);
    } catch (error) {
      thrown = (error as { code?: string }).code;
    }
    expect(thrown).toBe('REPOSITORY_FORBIDDEN');
  });

  it('never lets system actors hold user-facing capabilities', async () => {
    const repositoryId = crypto.randomUUID();
    // policy:read is user-facing; even with linkage present it must deny.
    // Linkage fails first here, so probe via the deny path ordering instead:
    const result = await container.authorizer.authorize({
      principal: { kind: 'system', serviceId: 'worker.x', binding: {} },
      repositoryId,
      capability: 'repository:privileged_action',
    });
    expect(['deny']).toContain(result.effect);
    expect(result.reasonCode).toBe('system_actor_capability_forbidden');
  });
});

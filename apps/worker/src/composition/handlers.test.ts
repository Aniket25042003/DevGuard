/** CP008 — worker handlers: workflow.execute transitions runs; others fail closed. */
import { describe, expect, it } from 'vitest';
import { buildEnvelope, InMemoryDeliveryStore, JobRegistry } from '@devguard/queue';
import {
  registerApprovalResume,
  registerFailClosedHandlers,
  registerUnavailablePersistenceHandlers,
  registerWebhookProcess,
  registerWorkflowExecute,
  volatileRunTransitions,
  type RunTransitionPort,
} from './handlers.js';

function executeEnvelope(runId: string) {
  return buildEnvelope({
    jobType: 'workflow.execute',
    schemaVersion: 1,
    queue: 'workflow-execution',
    uniqueKey: `run-${runId}`,
    payload: { runId, stepId: 'start', stepAttempt: 0 },
    correlationId: 'c1',
    workflowRunId: runId,
  });
}

describe('worker handlers (CP008)', () => {
  it('workflow.execute succeeds when the run transitions to running', async () => {
    const registry = new JobRegistry();
    const transitions: RunTransitionPort = { markRunning: async () => true };
    registerWorkflowExecute(registry, transitions);
    const result = await registry.resolve('workflow.execute', 1)(executeEnvelope('run-1'), {
      attempt: 1,
      maxAttempts: 10,
      leaseToken: 'w:run-1',
      signal: undefined,
    });
    expect(result).toEqual({ outcome: 'SUCCEEDED', detail: 'run_started' });
  });

  it('workflow.execute fails when the run cannot transition (conflict/not-found)', async () => {
    const registry = new JobRegistry();
    registerWorkflowExecute(registry, volatileRunTransitions()); // always denies
    const result = await registry.resolve('workflow.execute', 1)(executeEnvelope('run-x'), {
      attempt: 1,
      maxAttempts: 10,
      leaseToken: 'w:run-x',
      signal: undefined,
    });
    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('persistence-backed job types fail closed without a database', async () => {
    const registry = new JobRegistry();
    registerUnavailablePersistenceHandlers(registry);
    for (const jobType of ['outbox.publish', 'cleanup.retention'] as const) {
      const handler = registry.resolve(jobType, 1);
      const result = await handler(
        buildEnvelope({
          jobType,
          schemaVersion: 1,
          queue: 'cleanup',
          uniqueKey: `x-${jobType}`,
          payload: {},
          correlationId: 'c',
        }),
        {
          attempt: 1,
          maxAttempts: 3,
          leaseToken: 'w',
          signal: undefined,
        },
      );
      expect(result.outcome).toBe('PERMANENT_FAILURE');
    }
  });

  it('sandbox.monitor still fails closed until CP013', async () => {
    const registry = new JobRegistry();
    registerFailClosedHandlers(registry);
    const handler = registry.resolve('sandbox.monitor', 1);
    const result = await handler(
      buildEnvelope({
        jobType: 'sandbox.monitor',
        schemaVersion: 1,
        queue: 'sandbox-monitoring',
        uniqueKey: 'x-sandbox',
        payload: {},
        correlationId: 'c',
      }),
      {
        attempt: 1,
        maxAttempts: 3,
        leaseToken: 'w',
        signal: undefined,
      },
    );
    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('approval.resume is wired to the resume state machine and DLQs unknown approvals', async () => {
    const registry = new JobRegistry();
    registerApprovalResume(registry);
    const handler = registry.resolve('approval.resume', 1);
    const result = await handler(
      buildEnvelope({
        jobType: 'approval.resume',
        schemaVersion: 1,
        queue: 'approval-resume',
        uniqueKey: 'app-1',
        payload: { approvalId: 'unknown-1', resolutionVersion: 1 },
        correlationId: 'c',
      }),
      { attempt: 1, maxAttempts: 12, leaseToken: 'w', signal: undefined },
    );
    // Unknown approval → the resume machine fails CLOSED (no silent success).
    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  it('webhook.process routes a non-mention event to IGNORED (succeeds)', async () => {
    const registry = new JobRegistry();
    registerWebhookProcess(registry, new InMemoryDeliveryStore());
    const result = await registry.resolve('webhook.process', 1)(
      buildEnvelope({
        jobType: 'webhook.process',
        schemaVersion: 1,
        queue: 'webhook-processing',
        uniqueKey: 'wb-1',
        payload: { deliveryId: 'd1', repositoryId: 'r1', payloadRef: 'ping' },
        correlationId: 'c',
      }),
      { attempt: 1, maxAttempts: 8, leaseToken: 'w', signal: undefined },
    );
    expect(result.outcome).toBe('SUCCEEDED');
  });
});

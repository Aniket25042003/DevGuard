/** CP008 — worker handlers: workflow.execute transitions runs; others fail closed. */
import { describe, expect, it } from 'vitest';
import { buildEnvelope, JobRegistry } from '@devguard/queue';
import {
  registerFailClosedHandlers,
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

  it('other job types fail closed until their owners mount', async () => {
    const registry = new JobRegistry();
    registerFailClosedHandlers(registry);
    for (const jobType of [
      'webhook.process',
      'approval.resume',
      'outbox.publish',
      'sandbox.monitor',
      'cleanup.retention',
    ] as const) {
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
});

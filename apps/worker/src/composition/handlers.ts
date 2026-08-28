/**
 * CP008 — worker job handlers.
 *
 * `workflow.execute` is the genuinely-wired one: it claims a queued run and
 * transitions it queued → running against the durable run store (real step
 * execution mounts at CP010/CP013; this is the honest claim/transition). The
 * other job types' dependencies land with their owning components, so they
 * FAIL CLOSED (never silently succeed) until those mount.
 */
import { WorkflowRunStore } from '@devguard/db';
import type { JobEnvelope, JobHandler, JobRegistry, JobTypeV1 } from '@devguard/queue';

export interface RunStoreExecutor {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

export interface RunTransitionPort {
  readonly markRunning: (runId: string) => Promise<boolean>;
}

/** Durable run transition backed by the Postgres run store. */
export function durableRunTransitions(pool: RunStoreExecutor): RunTransitionPort {
  const store = new WorkflowRunStore(pool);
  return {
    markRunning: async (runId) => {
      const detail = await store.getDetail(runId);
      if (detail === null || detail.status !== 'queued') return false;
      await store.transition(runId, detail.rowVersion, 'queued', 'running');
      return true;
    },
  };
}

/** Volatile (test-only) run transition that always fails closed. */
export function volatileRunTransitions(): RunTransitionPort {
  return { markRunning: async () => false };
}

/** Ensure a per-run delta anything a downstream owner can mount. */
export function registerWorkflowExecute(registry: JobRegistry, runStore: RunTransitionPort): void {
  registry.register('workflow.execute', 1, async (envelope: JobEnvelope) => {
    const runId = String(envelope.payload['runId'] ?? '');
    if (runId === '') return fail('workflow_job_missing_run');
    const started = await runStore.markRunning(runId);
    return started
      ? { outcome: 'SUCCEEDED' as const, detail: 'run_started' }
      : fail('workflow_start_conflict');
  });
}

/** Register the remaining job types as fail-closed until their owners land. */
export function registerFailClosedHandlers(registry: JobRegistry): void {
  const closed: Array<[JobTypeV1, string]> = [
    ['webhook.process', 'webhook_processor_unavailable_until_cp011'],
    ['approval.resume', 'approval_resume_unavailable_until_cp009'],
    ['outbox.publish', 'outbox_publish_unavailable_until_cp008'],
    ['sandbox.monitor', 'sandbox_monitor_unavailable_until_cp013'],
    ['cleanup.retention', 'cleanup_unavailable_until_cp012'],
  ];
  for (const [jobType, errorCode] of closed) {
    const handler: JobHandler = () => Promise.resolve(fail(errorCode));
    registry.register(jobType, 1, handler);
  }
}

export function fail(errorCode: string): {
  outcome: 'PERMANENT_FAILURE';
  errorCode: string;
} {
  return { outcome: 'PERMANENT_FAILURE', errorCode };
}
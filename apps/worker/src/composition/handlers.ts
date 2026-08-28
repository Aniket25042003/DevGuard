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
import {
  ApprovalResumeService,
  InMemoryApprovalStore,
  WebhookProcessingService,
  type JobEnvelope,
  type JobHandler,
  type JobRegistry,
  type JobTypeV1,
} from '@devguard/queue';

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

/**
 * CP011 — wire `webhook.process` to the C058 delivery service.
 * The delivery ledger is durable (`PostgresWebhookDeliveryStore` when a pool is
 * bound). No manual triggers are configured yet, so non-mention events route to
 * IGNORED; `issue_comment` mention parsing is CP019 (out of scope here).
 */
export function registerWebhookProcess(
  registry: JobRegistry,
  store: {
    state(deliveryId: string): Promise<string | undefined>;
    claim(deliveryId: string): Promise<{ ok: true; state: string } | { ok: false }>;
    transition(deliveryId: string, from: string, to: string): Promise<string>;
  },
): void {
  const service = new WebhookProcessingService({
    store: store as never,
    router: { route: async () => ({ matched: false, triggerKeys: [] }) },
    creator: { createRuns: async () => ({ runIds: [] }) },
  });
  registry.register('webhook.process', 1, async (envelope: JobEnvelope) => {
    const p = envelope.payload as {
      deliveryId?: string;
      repositoryId?: string;
      payloadRef?: string;
      event?: string;
    };
    if (p.deliveryId === undefined) return fail('webhook_job_missing_delivery');
    const outcome = await service.process({
      payload: {
        deliveryId: p.deliveryId,
        repositoryId: p.repositoryId ?? '',
        payloadRef: p.payloadRef ?? p.event ?? 'ping',
      },
    } as never);
    return outcome.ok
      ? { outcome: 'SUCCEEDED', detail: outcome.nextRun ?? 'routed' }
      : { outcome: 'RETRYABLE_FAILURE', errorCode: 'WEBHOOK_PROCESS_FAILED', detail: outcome.detail };
  });
}

/**
 * CP009 — wire `approval.resume` to the C059 resume state machine.
 * The executor (real approved-action execution) mounts at CP013; until then it
 * fails CLOSED so an approved approval is never silently resumed-as-done.
 */
export function registerApprovalResume(registry: JobRegistry): void {
  const service = new ApprovalResumeService({
    store: new InMemoryApprovalStore(),
    executor: {
      execute: async () => ({
        ok: false,
        code: 'approved_action_executor_unavailable_until_cp013',
      }),
    },
  });
  registry.register('approval.resume', 1, async (envelope: JobEnvelope) => {
    const approvalId = String(envelope.payload['approvalId'] ?? '');
    const resolutionVersion = Number(
      envelope.payload['resolutionVersion'] ?? envelope.payload['resolution_version'] ?? 1,
    );
    if (approvalId === '') return fail('approval_job_missing_id');
    const outcome = await service.resume(approvalId, resolutionVersion);
    if (outcome.ok) return { outcome: 'SUCCEEDED' as const, detail: outcome.state };
    return outcome.state === 'RETRY_WAIT'
      ? { outcome: 'RETRYABLE_FAILURE' as const, errorCode: 'RATE_LIMITED', detail: outcome.detail }
      : fail('APPROVAL_RESUME_FAILED');
  });
}

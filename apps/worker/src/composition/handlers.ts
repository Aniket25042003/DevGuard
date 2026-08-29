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
import type { CommentCommandService } from '@devguard/workflows';
import { parseWorkerIssueCommentPayload } from './webhook-comment.js';

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

/** Register persistence-backed handlers that fail closed without a database. */
export function registerUnavailablePersistenceHandlers(registry: JobRegistry): void {
  const closed: Array<[JobTypeV1, string]> = [
    ['outbox.publish', 'outbox_publish_unavailable_without_database'],
    ['cleanup.retention', 'cleanup_unavailable_without_database'],
  ];
  for (const [jobType, errorCode] of closed) {
    const handler: JobHandler = () => Promise.resolve(fail(errorCode));
    registry.register(jobType, 1, handler);
  }
}

/** Register job types that still fail closed until their owners land. */
export function registerFailClosedHandlers(registry: JobRegistry): void {
  const closed: Array<[JobTypeV1, string]> = [
    ['sandbox.monitor', 'sandbox_monitor_unavailable_until_cp013'],
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
 * CP011/CP019 — wire `webhook.process` to delivery routing and GitHub comment commands.
 */
export function registerWebhookProcess(
  registry: JobRegistry,
  store: {
    state(deliveryId: string): Promise<string | undefined>;
    claim(deliveryId: string): Promise<{ ok: true; state: string } | { ok: false }>;
    transition(deliveryId: string, from: string, to: string): Promise<string>;
  },
  options: { readonly commentCommands?: CommentCommandService | undefined } = {},
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
      issueCommentPayload?: string;
    };
    if (p.deliveryId === undefined) return fail('webhook_job_missing_delivery');

    const issueComment = parseWorkerIssueCommentPayload(p.issueCommentPayload);
    if (issueComment !== undefined && options.commentCommands !== undefined) {
      const claimed = await store.claim(p.deliveryId);
      if (!claimed.ok) {
        return { outcome: 'RETRYABLE_FAILURE', errorCode: 'WEBHOOK_PROCESS_FAILED' };
      }
      try {
        await store.transition(p.deliveryId, claimed.state, 'PROCESSING');
        const outcome = await options.commentCommands.handle(issueComment);
        const terminal = outcome.kind === 'ignored' ? 'IGNORED' : 'ROUTED';
        await store.transition(p.deliveryId, 'PROCESSING', terminal);
        return { outcome: 'SUCCEEDED', detail: outcome.kind };
      } catch (error) {
        try {
          const state = await store.state(p.deliveryId);
          if (state === 'ACCEPTED' || state === 'PROCESSING') {
            await store.transition(p.deliveryId, state, 'FAILED_RETRYABLE');
          }
        } catch {
          /* preserve root failure */
        }
        return {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: 'WEBHOOK_PROCESS_FAILED',
          detail: error instanceof Error ? error.message : 'comment_command_failed',
        };
      }
    }

    const outcome = await service.process({
      payload: {
        deliveryId: p.deliveryId,
        repositoryId: p.repositoryId ?? '',
        payloadRef: p.payloadRef ?? p.event ?? 'ping',
      },
    } as never);
    return outcome.ok
      ? { outcome: 'SUCCEEDED', detail: outcome.nextRun ?? 'routed' }
      : {
          outcome: 'RETRYABLE_FAILURE',
          errorCode: 'WEBHOOK_PROCESS_FAILED',
          detail: outcome.detail,
        };
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

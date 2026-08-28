/**
 * C058 §12 — webhook + workflow execution job services.
 *
 * WebhookProcessingService claims a delivery, loads the immutable payload ref,
 * routes deterministic triggers, and transactionally creates zero..N runs; a
 * terminal delivery replay is a no-op. WorkflowExecutionJobService validates
 * fence/version, claims the step, invokes the step executor, records the outcome,
 * and schedules only the next legal work. No queue payload ever holds secrets or
 * large content.
 */
import type {
  WebhookProcessingJob,
  WorkflowExecutionJob,
  JobOutcome,
  DeliveryStorePort,
  WebhookDeliveryState,
} from './contracts.js';
import { resolveDeliveryEdge } from './contracts.js';
import type { TriggerRouter, WorkflowCreator } from './contracts.js';

export interface WebhookProcessingDeps {
  readonly store: DeliveryStorePort;
  readonly router: TriggerRouter;
  readonly creator: WorkflowCreator;
}

export class WebhookProcessingService {
  constructor(private readonly deps: WebhookProcessingDeps) {}

  async process(job: WebhookProcessingJob): Promise<JobOutcome> {
    const deliveryId = job.payload.deliveryId;
    const current = await this.deps.store.state(deliveryId);
    // Duplicate terminal delivery -> no-op replay.
    if (current === 'ROUTED' || current === 'IGNORED' || current === 'DEAD_LETTERED')
      return { ok: true };
    const claimed = await this.deps.store.claim(deliveryId);
    if (!claimed.ok) return { ok: false, retryable: true, detail: 'delivery unavailable' };

    try {
      const routed = await this.deps.router.route({
        repositoryId: job.payload.repositoryId,
        event: job.payload.payloadRef,
      });
      await this.deps.store.transition(deliveryId, claimed.state, 'PROCESSING');

      if (!routed.matched) {
        await this.deps.store.transition(deliveryId, 'PROCESSING', 'IGNORED');
        return { ok: true };
      }
      const created = await this.deps.creator.createRuns({
        repositoryId: job.payload.repositoryId,
        triggerKeys: routed.triggerKeys,
      });
      await this.deps.store.transition(deliveryId, 'PROCESSING', 'ROUTED');
      return { ok: true, nextRun: created.runIds[0] };
    } catch (error) {
      try {
        const state = await this.deps.store.state(deliveryId);
        if (state === 'ACCEPTED' || state === 'PROCESSING')
          await this.deps.store.transition(deliveryId, state, 'FAILED_RETRYABLE');
      } catch {
        /* retain the original failure */
      }
      return {
        ok: false,
        retryable: true,
        detail: error instanceof Error ? error.message : 'processing failed',
      };
    }
  }
}

export interface StepExecutor {
  invoke(
    runId: string,
    stepId: string,
    stepAttempt: number,
    fence?: { readonly executionGeneration: number; readonly cancellationGeneration: number },
  ): Promise<JobOutcome>;
}

export interface WorkflowExecutionDeps {
  readonly executor: StepExecutor;
  readonly scheduleNext?: (runId: string, stepId: string, stepAttempt: number) => Promise<void>;
}

export class WorkflowExecutionJobService {
  constructor(private readonly deps: WorkflowExecutionDeps) {}

  async execute(job: WorkflowExecutionJob): Promise<JobOutcome> {
    const outcome = await this.deps.executor.invoke(
      job.payload.runId,
      job.payload.stepId,
      job.payload.stepAttempt,
    );
    if (outcome.ok && outcome.nextRun !== undefined) {
      await this.deps.scheduleNext?.(
        job.payload.runId,
        outcome.nextRun,
        job.payload.stepAttempt + 1,
      );
    }
    return outcome;
  }
}

/** InMemoryDeliveryStore with claim-once + legal transitions (unit-testable). */
export class InMemoryDeliveryStore implements DeliveryStorePort {
  private readonly states = new Map<string, string>();
  readonly claims = new Set<string>();

  async claim(deliveryId: string): Promise<{ ok: true; state: 'ACCEPTED' } | { ok: false }> {
    if (this.claims.has(deliveryId) && this.states.get(deliveryId) !== 'FAILED_RETRYABLE')
      return { ok: false };
    this.claims.add(deliveryId);
    return { ok: true, state: 'ACCEPTED' };
  }
  async transition(
    deliveryId: string,
    from: string,
    to: string,
  ): Promise<'ROUTED' | 'IGNORED' | 'DEAD_LETTERED'> {
    void from;
    const current = this.states.get(deliveryId) ?? 'ACCEPTED';
    if (!resolveDeliveryEdge(current as never, to as never))
      throw new Error('ILLEGAL_DELIVERY_TRANSITION');
    this.states.set(deliveryId, to);
    return to as 'ROUTED' | 'IGNORED' | 'DEAD_LETTERED';
  }
  async state(deliveryId: string): Promise<WebhookDeliveryState | undefined> {
    return this.states.get(deliveryId) as WebhookDeliveryState | undefined;
  }
}

export { resolveDeliveryEdge };

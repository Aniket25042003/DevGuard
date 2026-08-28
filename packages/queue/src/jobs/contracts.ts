/**
 * C058 §8/§9/§10 — webhook + workflow job contracts and delivery FSM.
 *
 * Queue payloads carry IDs/snapshots/keys only — never secrets, tokens, raw
 * provider bodies, or large source/log content. Webhook delivery is claimed
 * exactly once and transitions to ROUTED|IGNORED|FAILED_RETRYABLE|DEAD_LETTERED;
 * duplicate terminal deliveries are no-op replays. Workflow execution jobs are
 * fenced by execution/cancellation generation and lock ownership.
 */
import type { JobEnvelope } from '../envelope.js';

export const WEBHOOK_DELIVERY_STATES = [
  'ACCEPTED',
  'PROCESSING',
  'ROUTED',
  'IGNORED',
  'FAILED_RETRYABLE',
  'DEAD_LETTERED',
] as const;
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

export type JobOutcome =
  | { readonly ok: true; readonly nextRun?: string | undefined }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly terminal?: boolean;
      readonly detail: string;
    };

export interface WebhookProcessingJob extends JobEnvelope<'webhook.process'> {
  readonly payload: {
    readonly deliveryId: string;
    readonly payloadRef: string;
    readonly repositoryId: string;
  };
}

export interface WorkflowExecutionJob extends JobEnvelope<'workflow.execute'> {
  readonly payload: {
    readonly runId: string;
    readonly stepId: string;
    readonly stepAttempt: number;
    readonly executionGeneration: number;
    readonly cancellationGeneration: number;
  };
}

export type DeliveryVerdict = {
  readonly kind: WebhookDeliveryState;
  readonly triggerKeys?: readonly string[];
};

export function resolveDeliveryEdge(from: WebhookDeliveryState, to: WebhookDeliveryState): boolean {
  if (from === 'DEAD_LETTERED') return false;
  if (from === 'ROUTED' || from === 'IGNORED') return to === from;
  if (to === from) return true;
  const legal: Readonly<Record<WebhookDeliveryState, readonly WebhookDeliveryState[]>> = {
    ACCEPTED: ['PROCESSING', 'FAILED_RETRYABLE'],
    PROCESSING: ['ROUTED', 'IGNORED', 'FAILED_RETRYABLE', 'DEAD_LETTERED'],
    ROUTED: ['ROUTED'],
    IGNORED: ['IGNORED'],
    FAILED_RETRYABLE: ['PROCESSING', 'DEAD_LETTERED'],
    DEAD_LETTERED: [],
  };
  return (legal[from] ?? []).includes(to);
}

export interface TriggerRouter {
  route(input: {
    repositoryId: string;
    event: string;
    action?: string | undefined;
  }): Promise<{ readonly matched: boolean; readonly triggerKeys: readonly string[] }>;
}

export interface WorkflowCreator {
  createRuns(input: {
    repositoryId: string;
    triggerKeys: readonly string[];
  }): Promise<{ readonly runIds: readonly string[] }>;
}

export interface DeliveryStorePort {
  claim(deliveryId: string): Promise<{ ok: true; state: WebhookDeliveryState } | { ok: false }>;
  transition(
    deliveryId: string,
    from: WebhookDeliveryState,
    to: WebhookDeliveryState,
  ): Promise<WebhookDeliveryState>;
  state(deliveryId: string): Promise<WebhookDeliveryState | undefined>;
}

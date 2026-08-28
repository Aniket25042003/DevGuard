/**
 * C022 §10/§12 — GitHub webhook processor (durable async worker).
 *
 * Leasons the delivery row, hash-checks the vaulted raw payload, normalizes the
 * event, matches policy triggers, and routes idempotent workflow commands.
 * Mutable payload state is treated as a hint; current GitHub state is
 * authoritative (reconciliation read is injected). Unsupported/unknown events
 * become auditable `ignored`, never errors.
 */
import {
  bytesToString,
  resolveDeliveryTransition,
  sha256Hex,
  type DeliveryLedgerPort,
  type PayloadVaultPort,
} from './delivery-ledger.js';
import type { NormalizedWebhookEvent, WebhookEventName } from './contracts.js';
import type { WebhookNormalizer } from './normalizer.js';
import type { TriggerRouter } from './trigger-router.js';

export type ProcessingResult =
  | { readonly outcome: 'routed'; readonly routes: number }
  | { readonly outcome: 'ignored'; readonly reason: string }
  | { readonly outcome: 'retry_wait'; readonly errorCode: string };

export interface CurrentStateReconciler {
  /** Optional authoritative current-state fetch; returns false to skip routing. */
  isCurrent(event: NormalizedWebhookEvent): Promise<boolean>;
}

export const NoopCurrentStateReconciler: CurrentStateReconciler = {
  async isCurrent(): Promise<boolean> {
    return true;
  },
};

export interface ProcessorEvent {
  readonly type: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}
export interface ProcessorEventSinkPort {
  emit(event: ProcessorEvent): Promise<void>;
}

export class GitHubWebhookProcessor {
  constructor(
    private readonly ledger: DeliveryLedgerPort,
    private readonly vault: PayloadVaultPort,
    private readonly normalizer: WebhookNormalizer,
    private readonly router: TriggerRouter,
    private readonly reconcileCurrent: CurrentStateReconciler,
    private readonly emit: ProcessorEventSinkPort,
  ) {}

  async process(input: { deliveryId: string; leaseToken: string }): Promise<ProcessingResult> {
    void input.leaseToken;
    const row = await this.ledger.get(input.deliveryId);
    if (row === undefined) return { outcome: 'ignored', reason: 'unknown_delivery' };
    const processTo = resolveDeliveryTransition(row.state, 'process');
    if (processTo === undefined)
      return { outcome: 'ignored', reason: `cannot_process_from_${row.state}` };
    await this.ledger.transition(input.deliveryId, processTo);

    const raw = this.vault.get(input.deliveryId);
    if (raw === undefined) {
      await this.ledger.transition(input.deliveryId, 'retry_wait', 'payload_missing');
      return { outcome: 'retry_wait', errorCode: 'payload_missing' };
    }
    if (sha256Hex(bytesToString(raw)) !== row.payloadHash) {
      await this.ledger.transition(input.deliveryId, 'dead_lettered', 'payload_hash_mismatch');
      return { outcome: 'ignored', reason: 'payload_hash_mismatch' };
    }

    const normalized = this.normalizer.normalize(raw, row.event as WebhookEventName);
    if (!normalized.ok) {
      await this.ledger.transition(input.deliveryId, 'ignored', normalized.reason);
      return { outcome: 'ignored', reason: normalized.reason };
    }

    await this.event('webhook.processing', input.deliveryId, row.event);
    const current = await this.reconcileCurrent.isCurrent(normalized.event);
    if (!current) {
      await this.ledger.transition(input.deliveryId, 'ignored', 'stale');
      return { outcome: 'ignored', reason: 'stale' };
    }

    const routed = this.router.route(normalized.event, input.deliveryId);
    if (!routed.matched) {
      await this.ledger.transition(input.deliveryId, 'ignored', routed.reason);
      await this.event('webhook.ignored', input.deliveryId, row.event);
      return { outcome: 'ignored', reason: routed.reason };
    }
    const reconciled = resolveDeliveryTransition(processTo, 'reconcile');
    if (reconciled) await this.ledger.transition(input.deliveryId, reconciled);
    await this.ledger.transition(input.deliveryId, 'routed');
    await this.event('webhook.routed', input.deliveryId, row.event);
    return { outcome: 'routed', routes: routed.routes.length };
  }

  private async event(type: string, deliveryId: string, eventName: string): Promise<void> {
    await this.emit.emit({ type, deliveryId, event: eventName });
  }
}

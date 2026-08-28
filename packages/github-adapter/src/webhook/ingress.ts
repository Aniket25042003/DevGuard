/**
 * C022 §10/§12 — GitHub webhook ingress (fast-ack HTTP acceptance).
 *
 * Verify raw-body HMAC BEFORE parsing; durably claim the delivery; then return
 * a fast `202`. The response never depends on normalization, provider fetches,
 * policy, or workflow start. Invalid signatures never enter the trusted FSM.
 */
import {
  githubWebhookHeadersSchema,
  type GitHubWebhookHeaders,
  type SafeRemoteMetadata,
  type WebhookAcceptance,
} from './contracts.js';
import {
  deliveryRow,
  type DeliveryLedgerPort,
  type PayloadVaultPort,
  resolveDeliveryTransition,
} from './delivery-ledger.js';
import type { WebhookSignatureVerifier } from './signature-verifier.js';

export interface WebhookIngressEvent {
  readonly type: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}
export interface WebhookEventSinkPort {
  emit(event: WebhookIngressEvent): Promise<void>;
}

export interface GitHubWebhookIngressDeps {
  readonly verifier: WebhookSignatureVerifier;
  readonly ledger: DeliveryLedgerPort;
  readonly vault: PayloadVaultPort;
  readonly maxPayloadBytes?: number;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: WebhookEventSinkPort;
}

export class GitHubWebhookIngress {
  readonly #verifier: WebhookSignatureVerifier;
  readonly #ledger: DeliveryLedgerPort;
  readonly #vault: PayloadVaultPort;
  readonly #maxPayloadBytes: number;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: WebhookEventSinkPort;

  constructor(deps: GitHubWebhookIngressDeps) {
    this.#verifier = deps.verifier;
    this.#ledger = deps.ledger;
    this.#vault = deps.vault;
    this.#maxPayloadBytes = deps.maxPayloadBytes ?? 1_000_000;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? { emit: async () => undefined };
  }

  async accept(input: {
    rawBody: Uint8Array;
    headers: GitHubWebhookHeaders;
    receivedAt?: string;
    requestId: string;
    remoteMetadata?: SafeRemoteMetadata | undefined;
  }): Promise<WebhookAcceptance> {
    void input.requestId;
    void input.remoteMetadata;
    const parsed = githubWebhookHeadersSchema.safeParse(input.headers);
    if (!parsed.success) return { kind: 'rejected', code: 'HEADERS_INVALID' };
    const headers = parsed.data;

    if (input.rawBody.byteLength > this.#maxPayloadBytes) {
      return { kind: 'rejected', code: 'PAYLOAD_TOO_LARGE' };
    }

    const verify = await this.#verifier.verify(input.rawBody, headers.signature);
    if (!verify.ok || verify.version === undefined) {
      return { kind: 'rejected', code: 'SIGNATURE_INVALID' };
    }

    const receivedAt = input.receivedAt ?? this.#clock.nowIso();
    const row = deliveryRow(
      headers.deliveryId,
      headers.event,
      verify.version,
      input.rawBody,
      receivedAt,
    );
    const claimed = await this.#ledger.claim(row);
    if (!claimed.ok) {
      return { kind: 'duplicate', deliveryId: headers.deliveryId, currentState: claimed.row.state };
    }

    this.#vault.put(headers.deliveryId, input.rawBody);
    const next = resolveDeliveryTransition('accepted', 'dispatch');
    if (next) await this.#ledger.transition(headers.deliveryId, next);
    await this.event('webhook.accepted', headers.deliveryId, headers.event);
    return { kind: 'accepted', deliveryId: headers.deliveryId };
  }

  private async event(type: string, deliveryId: string, eventName: string): Promise<void> {
    await this.#emit.emit({ type, deliveryId, event: eventName });
  }
}

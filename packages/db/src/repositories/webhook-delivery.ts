/**
 * CP011 (C022) — durable GitHub webhook delivery ledger.
 *
 * Keyed by the GitHub delivery id; the raw body is never stored (only its
 * sha256). Implements the queue's `DeliveryStorePort` structurally (the state
 * union is mirrored here, so db stays independent of @devguard/queue) so the
 * C058 `WebhookProcessingService` can claim/route/transition durably, and
 * exposes `insert` for the ingress (persist before 202; duplicate → replay).
 */

import type { TransactionContext } from '../transaction.js';

/** Mirrors the C022 delivery FSM state union (db stays independent). */
export type DeliveryStateV1 =
  'ACCEPTED' | 'PROCESSING' | 'ROUTED' | 'IGNORED' | 'FAILED_RETRYABLE' | 'DEAD_LETTERED';

const LEGAL: Readonly<Record<DeliveryStateV1, readonly DeliveryStateV1[]>> = {
  ACCEPTED: ['PROCESSING', 'FAILED_RETRYABLE'],
  PROCESSING: ['ROUTED', 'IGNORED', 'FAILED_RETRYABLE', 'DEAD_LETTERED'],
  ROUTED: ['ROUTED'],
  IGNORED: ['IGNORED'],
  FAILED_RETRYABLE: ['PROCESSING', 'DEAD_LETTERED'],
  DEAD_LETTERED: [],
};

interface Queryish {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

export class PostgresWebhookDeliveryStore {
  constructor(private readonly pool: Queryish) {}

  async insert(
    input: {
    readonly githubDeliveryId: string;
    readonly githubEvent: string;
    readonly rawPayloadHash: string;
    readonly payloadRef?: string | undefined;
    readonly repositoryId?: string | undefined;
    },
    executor: Queryish | TransactionContext = this.pool,
  ): Promise<{ accepted: boolean; replay: boolean }> {
    const rows = await executor.query<Record<string, unknown>>({
      text: `INSERT INTO github_webhook_deliveries (github_delivery_id, github_event, raw_payload_hash, payload_ref, repository_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (github_delivery_id) DO NOTHING
RETURNING github_delivery_id`,
      values: [
        input.githubDeliveryId,
        input.githubEvent,
        input.rawPayloadHash,
        input.payloadRef ?? '',
        input.repositoryId ?? null,
      ],
    });
    if (rows.length > 0) return { accepted: true, replay: false };
    const existing = await executor.query<{
      raw_payload_hash: string;
      github_event: string;
      repository_id: string | null;
    }>({
      text: 'SELECT raw_payload_hash, github_event, repository_id FROM github_webhook_deliveries WHERE github_delivery_id = $1',
      values: [input.githubDeliveryId],
    });
    const row = existing[0];
    if (
      row === undefined ||
      row.raw_payload_hash !== input.rawPayloadHash ||
      row.github_event !== input.githubEvent ||
      row.repository_id !== (input.repositoryId ?? null)
    ) {
      throw new Error('WEBHOOK_DELIVERY_CONFLICT');
    }
    return { accepted: true, replay: true };
  }

  async acceptDelivery(record: {
    readonly deliveryId: string;
    readonly eventType: string;
    readonly payloadDigest: string;
    readonly repositoryExternalId?: string;
  }): Promise<
    | { outcome: 'accepted_new'; status: DeliveryStateV1 }
    | { outcome: 'duplicate'; status: DeliveryStateV1 }
    | { outcome: 'conflict'; existingStatus: DeliveryStateV1 }
  > {
    try {
      const result = await this.insert({
        githubDeliveryId: record.deliveryId,
        githubEvent: record.eventType,
        rawPayloadHash: record.payloadDigest,
        repositoryId: record.repositoryExternalId,
      });
      if (!result.replay) return { outcome: 'accepted_new', status: 'ACCEPTED' };
      const status = await this.state(record.deliveryId);
      return { outcome: 'duplicate', status: status ?? 'ACCEPTED' };
    } catch (error) {
      if (error instanceof Error && error.message === 'WEBHOOK_DELIVERY_CONFLICT') {
        const status = await this.state(record.deliveryId);
        return { outcome: 'conflict', existingStatus: status ?? 'ACCEPTED' };
      }
      throw error;
    }
  }

  async state(deliveryId: string): Promise<DeliveryStateV1 | undefined> {
    const rows = await this.pool.query<{ state: string }>({
      text: 'SELECT state FROM github_webhook_deliveries WHERE github_delivery_id = $1',
      values: [deliveryId],
    });
    const row = rows[0];
    return row === undefined ? undefined : (row.state as DeliveryStateV1);
  }

  async claim(deliveryId: string): Promise<{ ok: true; state: DeliveryStateV1 } | { ok: false }> {
    const rows = await this.pool.query<{ state: string }>({
      text: `UPDATE github_webhook_deliveries
SET state = 'PROCESSING', updated_at = now()
WHERE github_delivery_id = $1 AND state IN ('ACCEPTED', 'FAILED_RETRYABLE')
RETURNING state`,
      values: [deliveryId],
    });
    return rows.length > 0 ? { ok: true, state: 'PROCESSING' } : { ok: false };
  }

  async transition(
    deliveryId: string,
    from: DeliveryStateV1,
    to: DeliveryStateV1,
  ): Promise<DeliveryStateV1> {
    if (!LEGAL[from].includes(to)) throw new Error(`ILLEGAL_DELIVERY_TRANSITION:${from}->${to}`);
    const rows = await this.pool.query<{ state: string }>({
      text: `UPDATE github_webhook_deliveries SET state = $2, processed_at = now(), updated_at = now()
WHERE github_delivery_id = $1 AND state = $3
RETURNING state`,
      values: [deliveryId, to, from],
    });
    const row = rows[0];
    if (row === undefined) throw new Error(`ILLEGAL_DELIVERY_TRANSITION:${from}->${to}`);
    return row.state as DeliveryStateV1;
  }
}

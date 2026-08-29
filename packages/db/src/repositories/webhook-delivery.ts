/**
 * CP011 (C022) — durable GitHub webhook delivery ledger.
 *
 * Keyed by the GitHub delivery id; the raw body is never stored (only its
 * sha256). Implements the queue's `DeliveryStorePort` structurally (the state
 * union is mirrored here, so db stays independent of @devguard/queue) so the
 * C058 `WebhookProcessingService` can claim/route/transition durably, and
 * exposes `insert` for the ingress (persist before 202; duplicate → replay).
 */

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

  async insert(input: {
    readonly githubDeliveryId: string;
    readonly githubEvent: string;
    readonly rawPayloadHash: string;
    readonly payloadRef?: string | undefined;
    readonly repositoryId?: string | undefined;
  }): Promise<{ accepted: boolean; replay: boolean }> {
    const rows = await this.pool.query<Record<string, unknown>>({
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
    return rows.length > 0 ? { accepted: true, replay: false } : { accepted: true, replay: true };
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
    const rows = await this.pool.query<{ state: string }>({ text: "UPDATE github_webhook_deliveries SET state = 'PROCESSING', updated_at = now() WHERE github_delivery_id = $1 AND state IN ('ACCEPTED', 'FAILED_RETRYABLE') RETURNING state", values: [deliveryId] });
      if (rows.length > 0) return { ok: true, state: rows[0]!.state as DeliveryStateV1 };
      return { ok: false };
      /* const current = await this.state(deliveryId); */
    if (current === undefined) return { ok: true, state: 'ACCEPTED' };
    if (current === 'ACCEPTED' || current === 'FAILED_RETRYABLE')
      return { ok: true, state: current };
    return { ok: false };
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

/** CP011 §22 — webhook delivery ledger: insert replay + FSM transitions. */
import { describe, expect, it } from 'vitest';
import { PostgresWebhookDeliveryStore } from './webhook-delivery.js';

function stubPool() {
  const rows: Array<Record<string, unknown>[]> = [];
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let cursor = 0;
  return {
    calls,
    rows,
    query: async <T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]> => {
      calls.push(config);
      const next = rows[cursor];
      cursor += 1;
      return (next ?? []) as T[];
    },
  };
}

describe('PostgresWebhookDeliveryStore (CP011)', () => {
  it('insert is idempotent by github_delivery_id (replay on conflict)', async () => {
    const pool = stubPool();
    pool.rows.push([{ github_delivery_id: 'd1' }]);
    const store = new PostgresWebhookDeliveryStore(pool);
    const first = await store.insert({
      githubDeliveryId: 'd1',
      githubEvent: 'ping',
      rawPayloadHash: 'a'.repeat(64),
    });
    expect(first).toEqual({ accepted: true, replay: false });
    expect(pool.calls[0]?.text).toContain('ON CONFLICT (github_delivery_id) DO NOTHING');
  });

  it('maps state and enforces legal transitions', async () => {
    const pool = stubPool();
    pool.rows.push([{ state: 'ACCEPTED' }]); // state()
    pool.rows.push([{ state: 'PROCESSING' }]); // transition
    const store = new PostgresWebhookDeliveryStore(pool);
    expect(await store.state('d1')).toBe('ACCEPTED');
    expect(await store.transition('d1', 'ACCEPTED', 'PROCESSING')).toBe('PROCESSING');
    await expect(store.transition('d1', 'ACCEPTED', 'ROUTED')).rejects.toThrow(/ILLEGAL/);
  });
});

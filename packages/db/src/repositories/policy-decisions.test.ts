/** CP009 §22 — policy-decision store: row mapping + conflict-upsert. */
import { describe, expect, it } from 'vitest';
import { PostgresPolicyDecisionStore } from './policy-decisions.js';

function stubPool(rows: unknown[] = []) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  let cursor = 0;
  return {
    calls,
    query: async <T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]> => {
      calls.push(config);
      const next = rows[cursor];
      cursor += 1;
      return (next ?? []) as T[];
    },
  };
}

describe('PostgresPolicyDecisionStore (CP009)', () => {
  it('maps a written decision row', async () => {
    const pool = stubPool([
      [
        {
          run_id: 'r1',
          policy_version: 'v1',
          effect: 'allow',
          reason_code: 'allow_standard',
          decided_at: '2026-01-01T00:00:00Z',
          row_version: '1',
        },
      ],
    ]);
    const store = new PostgresPolicyDecisionStore(pool);
    const record = await store.recordDecision({
      runId: 'r1',
      policyVersion: 'v1',
      effect: 'allow',
      reasonCode: 'allow_standard',
    });
    expect(record).toMatchObject({ runId: 'r1', effect: 'allow', rowVersion: 1 });
    expect(pool.calls[0]?.text).toContain('ON CONFLICT (run_id) DO UPDATE');
  });

  it('returns null and maps read rows for getDecision', async () => {
    const empty = stubPool([]);
    const store = new PostgresPolicyDecisionStore(empty);
    expect(await store.getDecision('r-missing')).toBeNull();

    const filled = stubPool([
      [
        {
          run_id: 'r1',
          policy_version: 'v2',
          effect: 'require_approval',
          reason_code: 'dangerous_action',
          decided_at: '2026-01-02T00:00:00Z',
          row_version: '3',
        },
      ],
    ]);
    const rec = await new PostgresPolicyDecisionStore(filled).getDecision('r1');
    expect(rec?.effect).toBe('require_approval');
    expect(rec?.rowVersion).toBe(3);
  });
});

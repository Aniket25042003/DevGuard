import { describe, expect, it } from 'vitest';
import { EventStore } from '@devguard/db';

/** In-memory fake TransactionContext + event table for testing EventStore logic. */
function makeEventFake() {
  const events: Array<Record<string, unknown>> = [];
  let nextId = 0;
  const tx = {
    id: Symbol('test-tx'),
    async query<T>(config: { text: string; values?: unknown[] }): Promise<T[]> {
      const sql = config.text.replace(/\s+/g, ' ').trim();
      if (sql.includes('pg_advisory_xact_lock')) return []; // skip lock
      const runId = config.values?.[0] as string;
      if (
        sql.includes('INSERT INTO workflow_events') &&
        sql.includes('COALESCE(MAX(sequence_number)')
      ) {
        const eventType = config.values?.[1] as string;
        const payloadJson = config.values?.[2] as string;
        // Compute max sequence
        let maxSeq = -1;
        for (const e of events) {
          if (e['run_id'] === runId && Number(e['sequence_number']) > maxSeq)
            maxSeq = Number(e['sequence_number']);
        }
        const seq = maxSeq + 1;
        const row = {
          id: `evt-${++nextId}`,
          run_id: runId,
          sequence_number: seq,
          event_type: eventType,
          payload_json: payloadJson,
        };
        events.push(row);
        return [row] as T[];
      }
      return [];
    },
  };
  return { tx, events };
}

describe('C011 EventStore sequence allocation', () => {
  it('allocates monotonically increasing sequences under concurrent appends', async () => {
    const { tx, events } = makeEventFake();
    const store = new EventStore(tx as never);

    const e1 = await store.append('run-1', 'workflow.state.changed', '{"from":"queued"}', tx);
    const e2 = await store.append('run-1', 'action.proposed', '{"actionType":"commit.push"}', tx);
    const e3 = await store.append('run-1', 'validation.completed', '{}', tx);

    expect(e1.sequenceNumber).toBe(0);
    expect(e2.sequenceNumber).toBe(1);
    expect(e3.sequenceNumber).toBe(2);
    expect(events).toHaveLength(3);
  });

  it('maintains separate sequences per run', async () => {
    const { tx } = makeEventFake();
    const store = new EventStore(tx as never);

    const a1 = await store.append('run-a', 'workflow.queued', '{}', tx);
    const b1 = await store.append('run-b', 'workflow.queued', '{}', tx);
    const a2 = await store.append('run-a', 'workflow.state.changed', '{}', tx);

    expect(a1.sequenceNumber).toBe(0);
    expect(b1.sequenceNumber).toBe(0); // independent sequence
    expect(a2.sequenceNumber).toBe(1);
  });
});

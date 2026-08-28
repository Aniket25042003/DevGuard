/**
 * CP006 §22 — DB-gated durability for the command-bus persistence path:
 * a run row + outbox event commit atomically, and a replayed idempotency key
 * returns the EXISTING run with no duplicate outbox event. Mirrors exactly the
 * SQL + unit-of-work the `PostgresCommandBusPersistencePort` composes.
 * Skips without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  createUnitOfWork,
  OutboxWriter,
  WorkflowRunStore,
  type DevGuardPool,
} from '@devguard/db';
import { requireDatabaseUrl } from './db-harness.js';
import { provisionDatabase, teardownDatabase } from '@devguard/test-harness';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;
let dbUrl: string;
const LEASED_DB = `dg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const handle = await provisionDatabase({
    adminUrl: requireDatabaseUrl(),
    databaseName: LEASED_DB,
  });
  await handle.pool.drain();
  dbUrl = handle.url;
  pool = createPool({ connectionString: dbUrl });
});

afterAll(async () => {
  await pool?.drain();
  await teardownDatabase(requireDatabaseUrl(), LEASED_DB);
});

const KEY_HASH = 'a'.repeat(64);
const RUN_ID = 'c8a2e9f0-1111-4222-8333-444455556666';

async function createQueuedRun(runId: string, keyHash: string) {
  return createUnitOfWork(pool).transaction(async (tx) => {
    const store = new WorkflowRunStore(tx as never);
    let created: { runId: string } | undefined;
    try {
      const record = await store.create({
        id: runId,
        repositoryId: 'repo-1',
        workflowType: 'review_remediation',
        triggerType: 'manual',
        triggerReferenceJson: JSON.stringify({ originSurface: 'cli', commandId: 'review' }),
        idempotencyKeyHash: keyHash,
        createdBy: 'user-1',
      });
      created = { runId: record.id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('IDEMPOTENCY_REPLAY')) {
        const existing = await store.findByIdempotencyKeyHash(keyHash);
        if (existing) return { outcome: 'replayed', runId: existing.id } as const;
      }
      throw error;
    }
    await new OutboxWriter().append(
      {
        eventType: 'workflow.queued',
        schemaVersion: 1,
        payload: { commandId: 'review_remediation', repositoryId: 'repo-1', originSurface: 'cli' },
        correlation: { runId: created.runId, commandId: 'review_remediation' },
        aggregateType: 'workflow_run',
        aggregateId: created.runId,
      },
      tx,
    );
    return { outcome: 'created', runId: created.runId } as const;
  });
}

describeDb('CP006 command-bus durable persistence', () => {
  it('persists a queued run AND the outbox event in one transaction', async () => {
    const result = await createQueuedRun(RUN_ID, KEY_HASH);
    expect(result.outcome).toBe('created');

    const runs = await pool.query<{ n: string }>({
      text: "SELECT count(*)::text AS n FROM workflow_runs WHERE id = $1 AND status = 'queued'",
      values: [RUN_ID],
    });
    expect(Number(runs[0]?.n ?? '0')).toBe(1);

    const outbox = await pool.query<{ n: string }>({
      text: "SELECT count(*)::text AS n FROM outbox_events WHERE event_type = 'workflow.queued' AND aggregate_id = $1",
      values: [RUN_ID],
    });
    expect(Number(outbox[0]?.n ?? '0')).toBe(1);
  });

  it('replaying the same idempotency key returns the existing run with no duplicate outbox event', async () => {
    const replay = await createQueuedRun(RUN_ID, KEY_HASH);
    expect(replay.outcome).toBe('replayed');
    expect(replay.runId).toBe(RUN_ID);

    // Exactly one run and one outbox event despite the replay attempt.
    const runs = await pool.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM workflow_runs WHERE id = $1',
      values: [RUN_ID],
    });
    expect(Number(runs[0]?.n ?? '0')).toBe(1);

    const outbox = await pool.query<{ n: string }>({
      text: 'SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_id = $1',
      values: [RUN_ID],
    });
    expect(Number(outbox[0]?.n ?? '0')).toBe(1);
  });
});

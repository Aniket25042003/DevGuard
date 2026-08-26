/**
 * C008 §22 — DB-gated integration: outbox append/rollback atomicity, SKIP
 * LOCKED concurrent claim, and CAS publish/reschedule/dead-letter lifecycle.
 * Skips without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_OUTBOX_ATTEMPTS,
  OutboxRepository,
  OutboxWriter,
  createPool,
  createUnitOfWork,
  runMigrations,
  uuidv7,
  type DevGuardPool,
  type OutboxRecord,
  type UnitOfWork,
} from '@devguard/db';
import { type DevGuardError } from '@devguard/errors';
import { TEST_DATABASE_URL } from './db-harness.js';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;
let uow: UnitOfWork;
let writer: OutboxWriter;
let repository: OutboxRepository;

function eventFor(tag: string) {
  return {
    eventType: 'test.event',
    schemaVersion: 1,
    payload: { tag },
    correlation: { runId: tag, actor: 'test' },
  };
}

async function countPendingEvents(): Promise<number> {
  const rows = await pool.query<{ n: string }>({
    text: "SELECT count(*)::text AS n FROM outbox_events WHERE status = 'pending'",
  });
  return Number(rows[0]?.n ?? '0');
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DATABASE_URL, max: 5 });
  await runMigrations(pool);
  uow = createUnitOfWork(pool);
  writer = new OutboxWriter();
  repository = new OutboxRepository(pool);
});

afterAll(async () => {
  await pool?.drain();
});

describeDb('C008 transactional outbox', () => {
  it('commits state change and event atomically; rolls back both on failure', async () => {
    await uow.transaction(async (tx) => {
      await writer.append(eventFor('committed'), tx);
      await tx.query({
        text: "INSERT INTO idempotency_records (id, scope, key_hash) VALUES ($1, 'outbox-test', 'committed')",
        values: [uuidv7()],
      });
    });
    const committed = await pool.query<{ n: string }>({
      text: "SELECT count(*)::text AS n FROM idempotency_records WHERE scope = 'outbox-test' AND key_hash = 'committed'",
    });
    expect(Number(committed[0]?.n ?? '0')).toBe(1);

    let failed = false;
    try {
      await uow.transaction(async (tx) => {
        await writer.append(eventFor('rolled-back'), tx);
        throw new Error('domain failure after append');
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // Only the committed event survived; the rolled-back append left no row.
    const events = await pool.query<{ payload: { tag?: string } }>({
      text: "SELECT payload_json AS payload FROM outbox_events WHERE event_type = 'test.event'",
    });
    expect(events.map((row) => row.payload?.tag)).toEqual(['committed']);
  });

  it('rejects empty or oversized payloads with VALIDATION_FAILED', async () => {
    await expect(
      uow.transaction((tx) => writer.append({ ...eventFor('x'), payload: {} }, tx)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      uow.transaction((tx) =>
        writer.append(
          { ...eventFor('x'), payload: { blob: 'y'.repeat(70_000) }, correlation: { a: 1 } },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('claims with leases so concurrent claimers never receive locked rows (SKIP LOCKED)', async () => {
    for (const tag of ['c1', 'c2', 'c3', 'c4']) {
      await uow.transaction((tx) => writer.append(eventFor(tag), tx));
    }
    const before = await countPendingEvents();
    expect(before).toBeGreaterThanOrEqual(4);

    // Holder locks the two oldest pending rows inside an open transaction.
    let unblockHolder!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      unblockHolder = resolve;
    });
    let releaseHolder!: () => void;
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holderDone = pool.withClient(async (client) => {
      await client.query('BEGIN');
      await client.query(
        `SELECT id FROM outbox_events WHERE status = 'pending'
         ORDER BY available_at, id LIMIT 2 FOR UPDATE`,
      );
      unblockHolder();
      await holderMayFinish;
      await client.query('ROLLBACK');
    });
    await holderAcquired;

    try {
      // Concurrent claimer must skip the holder's two locked rows.
      const claimed = await repository.claim(10, 60_000, 'worker-b');
      expect(claimed).toHaveLength(before - 2);
      expect(claimed.every((record) => record.id.length === 36)).toBe(true);
      // The skipped rows remain untouched pending rows owned by nobody.
      const untouched = await pool.query<{ n: string }>({
        text: "SELECT count(*)::text AS n FROM outbox_events WHERE status = 'pending' AND lease_owner IS NULL",
      });
      expect(Number(untouched[0]?.n ?? '0')).toBe(2);
    } finally {
      releaseHolder();
      await holderDone;
    }

    // Once the holder rolls back, everything is claimable again.
    const all = await repository.claim(20, 60_000, 'worker-c');
    expect(all.length).toBeGreaterThanOrEqual(before);
    for (const record of all) {
      expect(record.rowVersion >= 1n).toBe(true);
      expect(typeof record.payload).toBe('object');
    }
  });

  it('guards publish outcomes with row_version CAS and dead-letters at the attempt ceiling', async () => {
    await uow.transaction((tx) => writer.append(eventFor('cas'), tx));
    const [claimed] = await repository.claim(1, 60_000, 'worker-cas');
    if (!claimed) throw new Error('expected one claimed event');

    // Stale publisher loses.
    let caught: unknown;
    try {
      await repository.markPublished(claimed.id, claimed.rowVersion + 1n);
    } catch (error) {
      caught = error;
    }
    expect((caught as DevGuardError)?.code).toBe('VERSION_CONFLICT');

    // Reschedule bumps attempts and returns the event to pending.
    const first = await repository.reschedule(
      claimed.id,
      claimed.rowVersion,
      new Date().toISOString(),
      'PROVIDER_UNAVAILABLE',
    );
    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(1);

    const [reclaimed] = await repository.claim(1, 60_000, 'worker-cas');
    if (!reclaimed) throw new Error('expected reclaim after reschedule');
    expect(reclaimed.attempts).toBe(1);

    // Drive to the exported ceiling; the same CAS path transitions to dead_lettered.
    let current: OutboxRecord = reclaimed;
    let deadLettered = false;
    for (let guard = 0; guard <= MAX_OUTBOX_ATTEMPTS && !deadLettered; guard += 1) {
      const outcome = await repository.reschedule(
        current.id,
        current.rowVersion,
        new Date().toISOString(),
        'PROVIDER_UNAVAILABLE',
      );
      expect(outcome.attempts).toBeLessThanOrEqual(MAX_OUTBOX_ATTEMPTS);
      if (outcome.status === 'dead_lettered') {
        deadLettered = true;
        break;
      }
      const [next] = await repository.claim(1, 60_000, 'worker-cas');
      if (!next) throw new Error('expected re-claim of rescheduled event');
      current = next;
    }
    expect(deadLettered).toBe(true);
    expect(current.attempts + 1).toBe(MAX_OUTBOX_ATTEMPTS);

    // Terminal state is not claimable again.
    const remaining = await repository.claim(10, 60_000, 'worker-end');
    expect(remaining.find((record) => record.id === claimed.id)).toBeUndefined();
  });
});

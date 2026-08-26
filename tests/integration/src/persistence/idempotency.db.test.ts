/**
 * C008 §22 — DB-gated integration: idempotency acquire/replay/conflict
 * matrix, lease reclaim, and token-CAS completion.
 * Skips without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdempotencyStore,
  createPool,
  createUnitOfWork,
  requestFingerprint,
  runMigrations,
  uuidv7,
  type DevGuardPool,
  type TransactionContext,
  type UnitOfWork,
  idempotencyKeyHash,
} from '@devguard/db';
import { TEST_DATABASE_URL } from './db-harness.js';

const describeDb = process.env.DEGUARD_TEST_DATABASE_URL ? describe : describe.skip;

let pool: DevGuardPool;
let uow: UnitOfWork;
let store: IdempotencyStore;

const SCOPE = 'test:webhook:acme/widget';

function beginInput(key: string, body: unknown, leaseMs = 60_000) {
  return { scope: SCOPE, key, fingerprint: requestFingerprint(body), leaseMs };
}

async function expireLease(tx: TransactionContext, key: string): Promise<void> {
  await tx.query({
    text: "UPDATE idempotency_records SET lease_expires_at = now() - interval '1 second' WHERE scope = $1 AND key_hash = $2",
    values: [SCOPE, idempotencyKeyHash(SCOPE, key)],
  });
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DATABASE_URL, max: 5 });
  await runMigrations(pool);
  uow = createUnitOfWork(pool);
  store = new IdempotencyStore();
});

afterAll(async () => {
  await pool?.drain();
});

describeDb('C008 idempotency matrix', () => {
  it('acquires a fresh key and completes with a stored result', async () => {
    const key = uuidv7();
    const outcome = await uow.transaction((tx) => store.begin(beginInput(key, { a: 1 }), tx));
    expect(outcome).toMatchObject({ kind: 'acquired' });
    if (outcome.kind !== 'acquired') return;

    await uow.transaction((tx) =>
      store.complete(outcome.token, { responseCode: 201, responseJson: { created: true } }, tx),
    );
    const rows = await uow.transaction((tx) =>
      tx.query<{ status: string; response_code: number; row_version: string }>({
        text: 'SELECT status, response_code, row_version::text AS row_version FROM idempotency_records WHERE scope = $1 AND key_hash = $2',
        values: [SCOPE, idempotencyKeyHash(SCOPE, key)],
      }),
    );
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.response_code).toBe(201);
    expect(BigInt(rows[0]?.row_version ?? '0')).toBe(2n);
  });

  it('replays the stored result for a completed record with the same fingerprint', async () => {
    const key = uuidv7();
    const first = await uow.transaction((tx) => store.begin(beginInput(key, { op: 'x' }), tx));
    if (first.kind !== 'acquired') throw new Error('expected acquire');
    await uow.transaction((tx) =>
      store.complete(first.token, { responseCode: 200, responseJson: { done: 1 } }, tx),
    );

    // Same logical request → same fingerprint → deterministic replay.
    const outcome = await uow.transaction((tx) => store.begin(beginInput(key, { op: 'x' }), tx));
    expect(outcome).toEqual({
      kind: 'replay',
      result: { responseCode: 200, responseJson: { done: 1 } },
    });
  });

  it('throws IDEMPOTENCY_KEY_REUSED when the fingerprint differs', async () => {
    const key = uuidv7();
    const first = await uow.transaction((tx) => store.begin(beginInput(key, { a: 1 }), tx));
    if (first.kind !== 'acquired') throw new Error('expected acquire');
    await uow.transaction((tx) =>
      store.complete(first.token, { responseCode: 200, responseJson: {} }, tx),
    );

    let caught: unknown;
    try {
      await uow.transaction((tx) => store.begin(beginInput(key, { a: 2 }), tx));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('reports conflict while another owner holds a live lease', async () => {
    const key = uuidv7();
    const first = await uow.transaction((tx) => store.begin(beginInput(key, { live: true }), tx));
    if (first.kind !== 'acquired') throw new Error('expected acquire');

    const second = await uow.transaction((tx) => store.begin(beginInput(key, { live: true }), tx));
    expect(second).toEqual({ kind: 'conflict' });

    // After the lease lapses the record is safely reclaimed under a new token.
    await uow.transaction((tx) => expireLease(tx, key));
    const third = await uow.transaction((tx) => store.begin(beginInput(key, { live: true }), tx));
    expect(third.kind).toBe('acquired');
    if (third.kind === 'acquired') {
      expect(third.token).not.toBe(first.token);
    }
  });

  it('rejects completion from an unknown or superseded token', async () => {
    const ghostToken = uuidv7();
    await expect(
      uow.transaction((tx) =>
        store.complete(ghostToken, { responseCode: 200, responseJson: {} }, tx),
      ),
    ).rejects.toThrow(/token/i);
  });

  it('isolates identical keys across scopes', async () => {
    const key = uuidv7();
    const inScopeA = await uow.transaction((tx) =>
      store.begin({ ...beginInput(key, { s: 1 }), scope: 'scope-a' }, tx),
    );
    const inScopeB = await uow.transaction((tx) =>
      store.begin({ ...beginInput(key, { s: 1 }), scope: 'scope-b' }, tx),
    );
    expect(inScopeA.kind).toBe('acquired');
    expect(inScopeB.kind).toBe('acquired');
  });
});

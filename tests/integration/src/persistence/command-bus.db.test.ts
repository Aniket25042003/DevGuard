/**
 * CP006 §22 — DB-gated durability for the command-bus persistence path:
 * a run row + outbox event commit atomically, and a replayed idempotency key
 * returns the EXISTING run with no duplicate outbox event. Mirrors exactly the
 * SQL + unit-of-work the `PostgresCommandBusPersistencePort` composes.
 * Skips without DEGUARD_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectedRepositoryStore,
  createPool,
  createUnitOfWork,
  InstallationStore,
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
  // workflow_runs.repository_id is an FK to repositories, which itself FKs to a
  // github_installation; seed both (CP006 durable test runs in CI with a DB).
  const installationId = 'aaaaaaaa-1111-4222-8333-444444444444';
  await new InstallationStore(pool).upsertSnapshot({
    githubInstallationId: '777',
    accountType: 'User',
    accountId: 777,
    accountLogin: 'octo',
    status: 'active',
    permissionsJson: '{}',
    repositorySelection: 'selected',
  });
  // github_installations.id is auto-generated; read it back for the FK.
  const installRows = await pool.query<{ id: string }>({
    text: 'SELECT id::text AS id FROM github_installations WHERE github_installation_id = $1',
    values: ['777'],
  });
  const realInstallationId = String(installRows[0]?.id ?? installationId);
  await new ConnectedRepositoryStore(pool).insert({
    id: REPO,
    githubRepositoryId: '123456',
    installationId: realInstallationId,
    owner: 'octo',
    name: 'demo',
    fullName: 'octo/demo',
  });
});

afterAll(async () => {
  await pool?.drain();
  await teardownDatabase(requireDatabaseUrl(), LEASED_DB);
});

const KEY_HASH = 'a'.repeat(64);
const RUN_ID = 'c8a2e9f0-1111-4222-8333-444455556666';
const REPO = '11111111-2222-4333-8444-555555555555';
const FINGERPRINT =
  '{"commandId":"review_remediation","repositoryId":"11111111-2222-4333-8444-555555555555","originSurface":"cli","definitionVersion":"1.0.0"}';

async function createQueuedRun(runId: string, keyHash: string, fingerprint: string) {
  return createUnitOfWork(pool).transaction(async (tx) => {
    const store = new WorkflowRunStore(tx as never);
    let created: { runId: string } | undefined;
    try {
      const record = await store.create({
        id: runId,
        repositoryId: REPO,
        workflowType: 'review_remediation',
        triggerType: 'manual',
        triggerReferenceJson: JSON.stringify({
          originSurface: 'cli',
          commandId: 'review_remediation',
          requestFingerprint: fingerprint,
          definitionVersion: '1.0.0',
        }),
        idempotencyKeyHash: keyHash,
        definitionVersion: '1.0.0',
        createdBy: 'user-1',
      });
      created = { runId: record.id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('IDEMPOTENCY_REPLAY')) {
        const existing = await store.findByIdempotencyKeyHash(keyHash);
        if (existing) {
          const stored = (
            JSON.parse(existing.triggerReferenceJson) as { requestFingerprint?: string }
          ).requestFingerprint;
          if (stored === fingerprint) return { outcome: 'replayed', runId: existing.id } as const;
          throw new Error('IDEMPOTENCY_KEY_CONFLICT', { cause: error });
        }
      }
      throw error;
    }
    await new OutboxWriter().append(
      {
        // canonical C004 workflow.queued payload.
        eventType: 'workflow.queued',
        schemaVersion: 1,
        payload: { repositoryId: REPO, trigger: 'manual', requestedBy: 'user-1' },
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
    const result = await createQueuedRun(RUN_ID, KEY_HASH, FINGERPRINT);
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
    const replay = await createQueuedRun(RUN_ID, KEY_HASH, FINGERPRINT);
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

  it('conflicts when an idempotency key is reused with a DIFFERENT request fingerprint', async () => {
    let thrown: string | undefined;
    try {
      await createQueuedRun(RUN_ID, KEY_HASH, '{"commandId":"implement_issue","different":true}');
    } catch (error) {
      thrown = (error as { message?: string }).message ?? '';
    }
    expect(thrown).toContain('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describeDb('CP007 durable run list/get/cancel', () => {
  it('returns a durable projection via getDetail and keyset-paginated list', async () => {
    const store = new WorkflowRunStore(pool);
    const detail = await store.getDetail(RUN_ID);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(RUN_ID);
    expect(detail?.status).toBe('queued');
    expect(detail?.repositoryId).toBe(REPO);
    expect(detail?.workflowType).toBe('review_remediation');
    const page = await store.list({ repositoryId: REPO, limit: 10 });
    expect(page.length).toBe(1);
    expect(page[0]?.id).toBe(RUN_ID);
  });

  it('cancels a queued run via CAS and rejects stale/terminal cancels', async () => {
    const store = new WorkflowRunStore(pool);
    const before = await store.getDetail(RUN_ID);
    expect(before).not.toBeNull();
    const cancelled = await store.cancel(RUN_ID, before!.rowVersion);
    expect(cancelled.status).toBe('cancelled');
    // Reusing the same version after the transition conflicts (non-idempotent cas).
    await expect(store.cancel(RUN_ID, before!.rowVersion)).rejects.toThrow(/CANCEL_CONFLICT/);
  });
});

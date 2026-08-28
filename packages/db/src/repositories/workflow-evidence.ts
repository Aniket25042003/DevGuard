/**
 * C011 — Workflow run, step, session, action, event, and evidence stores.
 *
 * SQL terminates here. CAS transitions enforce legal state changes; event
 * sequence allocation is atomic under concurrent producers; append-only
 * decision/event tables never regress.
 */
import type { TransactionContext } from '../transaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewRunInput {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowType: string;
  readonly definitionVersion?: number | undefined;
  readonly triggerType: 'manual' | 'webhook' | 'api';
  readonly triggerReferenceJson: string;
  readonly idempotencyKeyHash?: string | undefined;
  readonly policySnapshotId?: string | undefined;
  readonly createdBy?: string | undefined;
}

export interface WorkflowRunRecord {
  readonly id: string;
  readonly status: string;
  readonly rowVersion: number;
}

const RUN_COLS = `id::text AS id, status, row_version::text AS row_version`;

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export class WorkflowRunStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async create(input: NewRunInput): Promise<WorkflowRunRecord> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `
INSERT INTO workflow_runs (id, repository_id, workflow_type, definition_version, trigger_type,
  trigger_reference_json, idempotency_key_hash, policy_snapshot_id, created_by)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
ON CONFLICT (idempotency_key_hash) DO NOTHING
RETURNING ${RUN_COLS}`,
      values: [
        input.id,
        input.repositoryId,
        input.workflowType,
        input.definitionVersion ?? 1,
        input.triggerType,
        input.triggerReferenceJson,
        input.idempotencyKeyHash ?? null,
        input.policySnapshotId ?? null,
        input.createdBy ?? 'system',
      ],
    });
    const row = rows[0];
    if (!row) throw new Error('IDEMPOTENCY_REPLAY:run already exists for this key');
    return {
      id: String(row['id']),
      status: String(row['status']),
      rowVersion: Number(row['row_version']),
    };
  }

  async findById(id: string): Promise<WorkflowRunRecord | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT ${RUN_COLS} FROM workflow_runs WHERE id = $1`,
      values: [id],
    });
    const row = rows[0];
    return row
      ? {
          id: String(row['id']),
          status: String(row['status']),
          rowVersion: Number(row['row_version']),
        }
      : null;
  }

  /** CP006 — resolve the existing run for a replayed idempotency key (dedupe). */
  async findByIdempotencyKeyHash(
    idempotencyKeyHash: string,
  ): Promise<{ id: string; triggerReferenceJson: string } | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT id::text AS id, trigger_reference_json::text AS trigger_reference_json
FROM workflow_runs WHERE idempotency_key_hash = $1`,
      values: [idempotencyKeyHash],
    });
    const row = rows[0];
    return row
      ? {
          id: String(row['id']),
          triggerReferenceJson: String(row['trigger_reference_json'] ?? '{}'),
        }
      : null;
  }

  private static readonly LEGAL: Readonly<Record<string, readonly string[]>> = Object.freeze({
    queued: ['running', 'cancelled'],
    running: [
      'waiting_for_approval',
      'resuming',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'timed_out',
    ],
    waiting_for_approval: ['resuming', 'rejected', 'expired', 'cancelled'],
    resuming: ['running', 'failed', 'cancelled'],
    verifying: ['completed', 'failed'],
    completed: [],
    failed: [],
    cancelled: [],
    rejected: [],
    timed_out: [],
  });

  async transition(
    id: string,
    expectedVersion: number,
    expectedStatus: string,
    next: string,
  ): Promise<WorkflowRunRecord> {
    const allowed = WorkflowRunStore.LEGAL[expectedStatus];
    if (!allowed?.includes(next)) {
      throw new Error(`ILLEGAL_TRANSITION:${expectedStatus}->${next}`);
    }
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `
UPDATE workflow_runs SET
  status = $2,
  started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
  completed_at = CASE WHEN $2 IN ('completed','failed','cancelled','rejected','timed_out') THEN now() ELSE completed_at END,
  cancel_requested_at = CASE WHEN $2 = 'waiting_for_approval' THEN cancel_requested_at ELSE cancel_requested_at END,
  updated_at = now(),
  row_version = row_version + 1
WHERE id = $1 AND row_version = $3 AND status = $4
RETURNING ${RUN_COLS}`,
      values: [id, next, expectedVersion],
    });
    const row = rows[0];
    if (!row) throw new Error(`VERSION_CONFLICT:expected=${expectedVersion}`);
    return {
      id: String(row['id']),
      status: String(row['status']),
      rowVersion: Number(row['row_version']),
    };
  }
}

// ---------------------------------------------------------------------------

interface EventRow {
  readonly id: string;
  readonly run_id: string;
  readonly sequence_number: number;
  readonly event_type: string;
  readonly payload_json: unknown;
}

export interface StoredEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly payloadJson: unknown;
}

export class EventStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  /**
   * Atomically allocate the next sequence number for the run and append.
   * The UNIQUE(run_id, sequence_number) constraint prevents concurrent gaps.
   */
  async append(
    runId: string,
    eventType: string,
    payloadJson: string,
    tx: TransactionContext,
  ): Promise<StoredEvent> {
    // Serialize per-run allocation to prevent concurrent MAX collisions.
    await tx.query({
      text: "SELECT pg_advisory_xact_lock(hashtext('devguard_events_' || $1))",
      values: [runId],
    });
    const rows = await tx.query<Record<string, unknown>>({
      text: `
INSERT INTO workflow_events (id, run_id, sequence_number, event_type, payload_json)
SELECT gen_random_uuid(), $1,
  COALESCE(MAX(sequence_number), -1) + 1, $2, $3::jsonb
FROM workflow_events WHERE run_id = $1
RETURNING id::text AS id, run_id::text AS run_id, sequence_number, event_type, payload_json`,
      values: [runId, eventType, payloadJson],
    });
    const row = rows[0] as unknown as EventRow;
    if (!row) throw new Error('event append returned no rows');
    return {
      eventId: String(row['id']),
      runId: String(row['run_id']),
      sequenceNumber: Number(row['sequence_number']),
      eventType: String(row['event_type']),
      payloadJson: row['payload_json'],
    };
  }

  async readAfter(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly StoredEvent[]> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT id::text AS id, run_id::text AS run_id, sequence_number, event_type, payload_json
FROM workflow_events WHERE run_id = $1 AND sequence_number > $2 ORDER BY sequence_number LIMIT $3`,
      values: [runId, afterSequence, limit],
    });
    return (rows as unknown as EventRow[]).map((row) => ({
      eventId: String(row['id']),
      runId: String(row['run_id']),
      sequenceNumber: Number(row['sequence_number']),
      eventType: String(row['event_type']),
      payloadJson: row['payload_json'],
    }));
  }
}

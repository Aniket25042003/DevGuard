/**
 * C008 — Transactional outbox: validated writer, SKIP LOCKED claim with
 * leases, and CAS publication outcomes (C008 §8–§10, §13, §19).
 *
 * The writer runs strictly inside the caller's transaction so a domain state
 * change and its publishable intent commit or roll back together. Publication
 * itself belongs to C060; this module only owns the durable row lifecycle.
 */
import { makeError, validationFailed } from '@devguard/errors';
import type { DevGuardPool } from '../pool.js';
import type { TransactionContext } from '../transaction.js';
import { uuidv7 } from '../uuid.js';

/** Hard ceiling on delivery attempts before an event is dead-lettered. */
export const MAX_OUTBOX_ATTEMPTS = 10;

/** Serialized payload/correlation must stay below 64KB each (C008 §17). */
export const MAX_OUTBOX_SERIALIZED_BYTES = 65_536;

export interface OutboxEventLike {
  readonly eventType: string;
  readonly schemaVersion: number;
  /** Non-empty JSON object; runtime-validated and schema-versioned (never a queryable invariant). */
  readonly payload: unknown;
  /** Non-empty JSON object carrying correlation/actor metadata. */
  readonly correlation: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly aggregateVersion?: bigint | number;
}

export interface OutboxRecord {
  readonly id: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly correlation: unknown;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly aggregateVersion: bigint | null;
  readonly attempts: number;
  readonly rowVersion: bigint;
}

interface OutboxRow {
  readonly id: string;
  readonly event_type: string | null;
  readonly schema_version: number | null;
  readonly payload_json: unknown;
  readonly correlation_json: unknown;
  readonly aggregate_type: string | null;
  readonly aggregate_id: string | null;
  readonly aggregate_version: string | null;
  readonly attempts: number;
  readonly row_version: string;
}

function assertNonEmptyObject(value: unknown, path: string): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw validationFailed([{ path, constraint: 'non_empty_object' }]);
  }
}

function assertBoundedJson(value: unknown, path: string): void {
  const serialized = JSON.stringify(value) ?? '';
  if (Buffer.byteLength(serialized, 'utf8') >= MAX_OUTBOX_SERIALIZED_BYTES) {
    throw validationFailed([{ path, constraint: `max_bytes_${MAX_OUTBOX_SERIALIZED_BYTES}` }]);
  }
}

/** Append a publishable intent inside the caller's transaction. */
export class OutboxWriter {
  async append(event: OutboxEventLike, tx: TransactionContext): Promise<void> {
    if (event.eventType.trim().length === 0) {
      throw validationFailed([{ path: 'eventType', constraint: 'non_empty' }]);
    }
    if (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
      throw validationFailed([{ path: 'schemaVersion', constraint: 'integer_gte_1' }]);
    }
    assertNonEmptyObject(event.payload, 'payload');
    assertNonEmptyObject(event.correlation, 'correlation');
    assertBoundedJson(event.payload, 'payload');
    assertBoundedJson(event.correlation, 'correlation');

    await tx.query({
      text: `
INSERT INTO outbox_events
  (id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version,
   payload_json, correlation_json, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
      values: [
        uuidv7(),
        event.aggregateType ?? null,
        event.aggregateId ?? null,
        event.aggregateVersion ?? null,
        event.eventType,
        event.schemaVersion,
        event.payload,
        event.correlation,
      ],
    });
  }
}

const CLAIM_SQL = `
UPDATE outbox_events
SET status = 'publishing',
    lease_owner = $1,
    lease_expires_at = now() + ($2::double precision / 1000) * interval '1 second',
    updated_at = now(),
    row_version = row_version + 1
WHERE id IN (
  SELECT id FROM outbox_events
  WHERE (status = 'pending' AND available_at <= now())
     OR (status = 'publishing' AND lease_expires_at < now())
  ORDER BY available_at, id
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
RETURNING id, event_type, schema_version, payload_json, correlation_json,
          aggregate_type, aggregate_id, aggregate_version, attempts, row_version::text AS row_version`;

const MARK_PUBLISHED_SQL = `
UPDATE outbox_events
SET status = 'published',
    published_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now(),
    row_version = row_version + 1
WHERE id = $1 AND row_version = $2 AND status = 'publishing'
RETURNING row_version::text AS row_version`;

/** One statement handles reschedule-vs-dead-letter after the attempt increment. */
const RESCHEDULE_SQL = `
UPDATE outbox_events
SET attempts = attempts + 1,
    status = CASE WHEN attempts + 1 >= $4 THEN 'dead_lettered' ELSE 'pending' END,
    available_at = CASE WHEN attempts + 1 >= $4 THEN available_at ELSE $3::timestamptz END,
    last_error_code = $5,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now(),
    row_version = row_version + 1
WHERE id = $1 AND row_version = $2 AND status = 'publishing'
RETURNING status, attempts`;

const DEAD_LETTER_SQL = `
UPDATE outbox_events
SET status = 'dead_lettered',
    last_error_code = $3,
    lease_owner = NULL,
    lease_expires_at = NULL,
    updated_at = now(),
    row_version = row_version + 1
WHERE id = $1 AND row_version = $2 AND status = 'publishing'
RETURNING row_version::text AS row_version`;

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    eventType: row.event_type ?? '',
    schemaVersion: row.schema_version ?? 0,
    payload: row.payload_json,
    correlation: row.correlation_json,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version === null ? null : BigInt(row.aggregate_version),
    attempts: row.attempts,
    rowVersion: BigInt(row.row_version),
  };
}

/**
 * Publisher-facing repository. Claim/lease/CAS semantics per C008 §19:
 * ordered batches, expired-lease recovery, stale-publisher protection.
 */
export class OutboxRepository {
  constructor(private readonly pool: DevGuardPool) {}

  /** Claim up to `batch` events for `owner`, skipping rows locked by peers. */
  async claim(batch: number, leaseMs: number, owner: string): Promise<OutboxRecord[]> {
    const rows = await this.pool.query<OutboxRow>({
      text: CLAIM_SQL,
      values: [owner, leaseMs, batch],
    });
    return rows.map(toRecord);
  }

  /** CAS transition to published; throws VERSION_CONFLICT on a stale publisher. */
  async markPublished(id: string, expectedRowVersion: bigint): Promise<void> {
    const rows = await this.pool.query<{ row_version: string }>({
      text: MARK_PUBLISHED_SQL,
      values: [id, expectedRowVersion.toString()],
    });
    if (rows.length === 0) {
      // Current row_version is unknowable at CAS failure without a second read;
      // no public details are attached rather than reporting a false value.
      throw makeError('VERSION_CONFLICT', { cause: 'outbox_cas_conflict' });
    }
  }

  /**
   * Release the lease and return the event to pending at `nextAt`, bumping
   * attempts. When the ceiling is reached the same CAS transitions the event
   * to dead_lettered instead.
   */
  async reschedule(
    id: string,
    expectedRowVersion: bigint,
    nextAt: string,
    errorCode: string,
  ): Promise<{ status: 'pending' | 'dead_lettered'; attempts: number }> {
    const rows = await this.pool.query<{ status: string; attempts: number }>({
      text: RESCHEDULE_SQL,
      values: [
        id,
        expectedRowVersion.toString(),
        nextAt,
        MAX_OUTBOX_ATTEMPTS,
        errorCode.slice(0, 128),
      ],
    });
    const row = rows[0];
    if (!row) {
      // Current row_version is unknowable at CAS failure without a second read;
      // no public details are attached rather than reporting a false value.
      throw makeError('VERSION_CONFLICT', { cause: 'outbox_cas_conflict' });
    }
    return {
      status: row.status as 'pending' | 'dead_lettered',
      attempts: row.attempts,
    };
  }

  /** Explicit terminal dead-letter transition (bounded, operator-visible). */
  async deadLetter(id: string, expectedRowVersion: bigint, errorCode: string): Promise<void> {
    const rows = await this.pool.query<{ row_version: string }>({
      text: DEAD_LETTER_SQL,
      values: [id, expectedRowVersion.toString(), errorCode.slice(0, 128)],
    });
    if (rows.length === 0) {
      // Current row_version is unknowable at CAS failure without a second read;
      // no public details are attached rather than reporting a false value.
      throw makeError('VERSION_CONFLICT', { cause: 'outbox_cas_conflict' });
    }
  }
}

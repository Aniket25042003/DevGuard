/**
 * C010 — Policy version/head and approval aggregate persistence.
 *
 * Immutable versions/snapshots/transitions; CAS on head pointer and approval
 * aggregate. Domain services (C023/C031–C035) own evaluation and FSM logic.
 */
import type { TransactionContext } from '../transaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanonicalPolicy {
  readonly repositoryId: string;
  readonly policyJson: string;
  readonly canonicalHash: string;
  readonly createdBy: string;
}

export interface ApprovalStatusTransition {
  readonly from: 'pending' | 'approved' | 'executing';
  readonly to: 'approved' | 'rejected' | 'expired' | 'stale' | 'executing' | 'executed' | 'failed';
  readonly actorType: 'user' | 'system';
  readonly actorId: string;
  readonly reasonCode: string;
  readonly commandKey: string;
  readonly resolutionComment?: string | undefined;
}

export type ApprovalDbStatus =
  'pending' | 'approved' | 'rejected' | 'expired' | 'stale' | 'executing' | 'executed' | 'failed';

const APPROVAL_COLS = `id, repository_id, workflow_run_id, action_type, status, risk_class,
  reason_code, reason_summary, operation_hash, fingerprint_hash, expires_at,
  resolved_by, resolved_at, row_version::text AS row_version`;

function mapApproval(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row['id']),
    repositoryId: String(row['repository_id']),
    workflowRunId: row['workflow_run_id'] ? String(row['workflow_run_id']) : undefined,
    actionType: String(row['action_type']),
    status: String(row['status']),
    riskClass: String(row['risk_class']),
    reasonCode: String(row['reason_code']),
    reasonSummary: String(row['reason_summary'] ?? ''),
    operationHash: String(row['operation_hash']),
    fingerprintHash: String(row['fingerprint_hash']),
    expiresAt: row['expires_at'] ? String(row['expires_at']) : undefined,
    resolvedBy: row['resolved_by'] ? String(row['resolved_by']) : undefined,
    resolvedAt: row['resolved_at'] ? String(row['resolved_at']) : undefined,
    rowVersion: Number(row['row_version'] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class PolicyVersionStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async appendVersion(
    input: CanonicalPolicy,
    tx?: TransactionContext,
  ): Promise<{ id: string; version: number }> {
    // Serialize per-repository allocation via advisory lock to prevent
    // concurrent MAX+1 races.
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    await executor.query({
      text: "SELECT pg_advisory_xact_lock(hashtext('devguard_policy_' || $1))",
      values: [input.repositoryId],
    });
    const rows = await executor.query<Record<string, unknown>>({
      text: `
INSERT INTO repository_policy_versions (id, repository_id, version, schema_version, policy_json, canonical_hash, created_by)
SELECT gen_random_uuid(), $1, COALESCE(MAX(version), 0) + 1, 1, $2::jsonb, $3, $4
FROM repository_policy_versions WHERE repository_id = $1
RETURNING id::text AS id, version`,
      values: [input.repositoryId, input.policyJson, input.canonicalHash, input.createdBy],
    });
    const row = rows[0];
    if (!row) throw new Error('append returned no rows');
    return { id: String(row['id']), version: Number(row['version']) };
  }

  async activateHead(
    repositoryId: string,
    versionId: string,
    expectedHeadRowVersion: number,
    updatedBy: string,
    tx?: TransactionContext,
  ): Promise<void> {
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };

    // Validate that the version belongs to this repository.
    const ownerCheck = await executor.query<{ repository_id: string }>({
      text: 'SELECT repository_id::text AS repository_id FROM repository_policy_versions WHERE id = $1',
      values: [versionId],
    });
    const ownerRepo = ownerCheck[0]?.['repository_id'];
    if (ownerRepo !== repositoryId) {
      throw new Error(
        `CROSS_REPOSITORY_POLICY:${versionId} belongs to ${ownerRepo ?? 'nothing'}, not ${repositoryId}`,
      );
    }

    const rows = await executor.query({
      text: `
INSERT INTO repository_policy_heads (repository_id, active_policy_version_id, updated_by, row_version)
VALUES ($1, $2, $3, 1)
ON CONFLICT (repository_id) DO UPDATE SET
  active_policy_version_id = EXCLUDED.active_policy_version_id,
  updated_by = EXCLUDED.updated_by,
  updated_at = now(),
  row_version = repository_policy_heads.row_version + 1
WHERE repository_policy_heads.row_version = $4
RETURNING row_version::text AS row_version`,
      values: [repositoryId, versionId, updatedBy, expectedHeadRowVersion],
    });
    if (rows.length === 0) {
      throw new Error(`HEAD_VERSION_CONFLICT:expected=${expectedHeadRowVersion}`);
    }
  }

  async getActive(repositoryId: string): Promise<{
    readonly version: number;
    readonly etag: string;
    readonly policyJson: string;
    readonly canonicalHash: string;
    readonly createdBy: string;
    readonly createdAt: string;
  } | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT v.version, v.policy_json::text AS policy_json, v.canonical_hash, v.created_by,
        v.created_at::text AS created_at, h.row_version::text AS etag
FROM repository_policy_heads h
JOIN repository_policy_versions v ON v.id = h.active_policy_version_id
WHERE h.repository_id = $1`,
      values: [repositoryId],
    });
    const row = rows[0];
    if (row === undefined) return null;
    return {
      version: Number(row['version']),
      etag: String(row['etag'] ?? '0'),
      policyJson: String(row['policy_json'] ?? '{}'),
      canonicalHash: String(row['canonical_hash'] ?? ''),
      createdBy: String(row['created_by'] ?? ''),
      createdAt: String(row['created_at'] ?? ''),
    };
  }

  async listVersions(repositoryId: string): Promise<
    readonly {
      readonly version: number;
      readonly createdBy: string;
      readonly createdAt: string;
      readonly canonicalHash: string;
    }[]
  > {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT version, created_by, created_at::text AS created_at, canonical_hash
FROM repository_policy_versions WHERE repository_id = $1 ORDER BY version DESC LIMIT 50`,
      values: [repositoryId],
    });
    return rows.map((row) => ({
      version: Number(row['version']),
      createdBy: String(row['created_by']),
      createdAt: String(row['created_at']),
      canonicalHash: String(row['canonical_hash']),
    }));
  }
}

export class ApprovalStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async insert(input: {
    readonly id: string;
    readonly repositoryId: string;
    readonly workflowRunId?: string | undefined;
    readonly actionType: string;
    readonly riskClass: string;
    readonly reasonCode: string;
    readonly reasonSummary?: string | undefined;
    readonly operationHash: string;
    readonly fingerprintHash: string;
    readonly expiresAt: string;
    tx?: TransactionContext | undefined;
  }): Promise<Record<string, unknown>> {
    const sql = `
INSERT INTO approvals (id, repository_id, workflow_run_id, action_type, risk_class, reason_code, reason_summary,
  operation_hash, fingerprint_hash, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING ${APPROVAL_COLS}`;
    const executor = input.tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    const rows = await executor.query<Record<string, unknown>>({
      text: sql,
      values: [
        input.id,
        input.repositoryId,
        input.workflowRunId ?? null,
        input.actionType,
        input.riskClass,
        input.reasonCode,
        input.reasonSummary ?? '',
        input.operationHash,
        input.fingerprintHash,
        input.expiresAt,
      ],
    });
    const row = rows[0];
    if (!row) throw new Error('insert returned no rows');
    return mapApproval(row);
  }

  async getForUpdate(id: string, tx: TransactionContext): Promise<Record<string, unknown> | null> {
    // FOR UPDATE requires an explicit transaction so the lock persists until
    // the caller commits — running through the pool releases it immediately.
    const rows = await tx.query<Record<string, unknown>>({
      text: `SELECT ${APPROVAL_COLS} FROM approvals WHERE id = $1 FOR UPDATE`,
      values: [id],
    });
    const row = rows[0];
    return row ? mapApproval(row) : null;
  }

  async transition(
    approvalId: string,
    expectedVersion: number,
    transition: ApprovalStatusTransition,
    tx: TransactionContext,
  ): Promise<Record<string, unknown>> {
    // Validate the transition at the DB level.
    const legalMap: Record<string, readonly string[]> = {
      pending: ['approved', 'rejected', 'expired', 'stale'],
      approved: ['stale', 'executing'],
      executing: ['executed', 'failed'],
    };
    const allowed = legalMap[transition.from];
    if (!allowed?.includes(transition.to)) {
      throw new Error(`ILLEGAL_TRANSITION:${transition.from}->${transition.to}`);
    }

    // Insert transition evidence (unique command key prevents duplicates).
    await tx.query({
      text: `INSERT INTO approval_transitions (id, approval_id, from_status, to_status, actor_type, actor_id, reason_code, command_key)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      values: [
        approvalId,
        transition.from,
        transition.to,
        transition.actorType,
        transition.actorId,
        transition.reasonCode,
        transition.commandKey,
      ],
    });

    const rows = await tx.query<Record<string, unknown>>({
      text: `
UPDATE approvals SET
  status = $2,
  resolved_by = CASE WHEN $2 IN ('approved', 'rejected') THEN $4 ELSE resolved_by END,
  resolution_comment = CASE WHEN $5 IS NOT NULL THEN $5 ELSE resolution_comment END,
  resolved_at = CASE WHEN $2 IN ('approved', 'rejected', 'expired', 'stale') THEN now() ELSE resolved_at END,
  execution_status = CASE WHEN $2 IN ('executing', 'executed', 'failed') THEN $2 ELSE execution_status END,
  executed_at = CASE WHEN $2 = 'executed' THEN now() ELSE executed_at END,
  updated_at = now(),
  row_version = row_version + 1
WHERE id = $1 AND row_version = $3 AND status = $6
RETURNING ${APPROVAL_COLS}`,
      values: [
        approvalId,
        transition.to,
        expectedVersion,
        transition.actorType === 'user' ? transition.actorId : null,
        transition.resolutionComment ?? null,
        transition.from,
      ],
    });
    const row = rows[0];
    if (!row) throw new Error(`VERSION_CONFLICT:expected=${expectedVersion}`);
    return mapApproval(row);
  }

  async list(filters: {
    readonly repositoryId?: string | undefined;
    readonly status?: string | undefined;
    readonly runId?: string | undefined;
  }): Promise<readonly Record<string, unknown>[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.repositoryId !== undefined) {
      values.push(filters.repositoryId);
      where.push(`repository_id = $${values.length}`);
    }
    if (filters.status !== undefined) {
      values.push(filters.status);
      where.push(`status = $${values.length}`);
    }
    if (filters.runId !== undefined) {
      values.push(filters.runId);
      where.push(`workflow_run_id = $${values.length}`);
    }
    const sql = `SELECT ${APPROVAL_COLS} FROM approvals ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC LIMIT 50`;
    const rows = await this.poolLike.query<Record<string, unknown>>({ text: sql, values });
    return rows.map(mapApproval);
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT ${APPROVAL_COLS} FROM approvals WHERE id = $1`,
      values: [id],
    });
    const row = rows[0];
    return row ? mapApproval(row) : null;
  }
}

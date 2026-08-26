/**
 * C012 — Retention policies, storage objects, holds, and lifecycle operations.
 *
 * Object bytes live behind the ObjectStore port; this module owns the
 * relational metadata and lifecycle state machine. No provider types leak.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionDecision {
  readonly ttlSeconds: number;
  readonly deleteMode: 'hard' | 'tombstone';
}

export interface RetentionPolicyInput {
  readonly scopeType: 'global' | 'repository' | 'workflow';
  readonly scopeId: string;
  readonly artifactType: string;
  readonly classification: string;
  readonly ttlSeconds: number;
  readonly minAuditTtlSeconds?: number | undefined;
  readonly deleteMode?: 'hard' | 'tombstone' | undefined;
  readonly createdBy?: string | undefined;
}

export interface ArtifactLifecycleRecord {
  readonly id: string;
  readonly status: string;
}

// ---------------------------------------------------------------------------
// RetentionResolver — most-specific match wins
// ---------------------------------------------------------------------------

interface PolicyRow {
  readonly scope_type: string;
  readonly scope_id: string;
  readonly artifact_type: string;
  readonly classification: string;
  readonly ttl_seconds: number;
  readonly min_audit_ttl_seconds: number;
  readonly delete_mode: string;
}

export class RetentionResolver {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async resolve(input: {
    readonly repositoryId: string;
    readonly type: string;
    readonly classification: string;
    readonly createdAt: string;
    readonly workflowId?: string | undefined;
  }): Promise<RetentionDecision> {
    const rows = await this.poolLike.query<PolicyRow>({
      text: `
SELECT scope_type, scope_id, artifact_type, classification,
       ttl_seconds, min_audit_ttl_seconds, delete_mode
FROM retention_policies
WHERE (artifact_type = $2 OR artifact_type = '*')
  AND (classification = $3 OR classification = '*')
  AND (
    (scope_type = 'workflow' AND scope_id = $4)
    OR (scope_type = 'repository' AND scope_id = $1)
    OR scope_type = 'global'
  )
ORDER BY
  CASE scope_type WHEN 'workflow' THEN 0 WHEN 'repository' THEN 1 ELSE 2 END,
  CASE WHEN artifact_type = $2 THEN 0 ELSE 1 END,
  CASE WHEN classification = $3 THEN 0 ELSE 1 END
LIMIT 1`,
      values: [input.repositoryId, input.type, input.classification, input.workflowId ?? null],
    });

    const row = rows[0];
    if (!row) {
      // Conservative default: retain internal artifacts for 30 days.
      return { ttlSeconds: 30 * 86_400, deleteMode: 'hard' };
    }
    const ttl = Math.max(row.ttl_seconds, row.min_audit_ttl_seconds);
    return { ttlSeconds: ttl, deleteMode: (row.delete_mode as 'hard' | 'tombstone') ?? 'hard' };
  }
}

// ---------------------------------------------------------------------------
// StorageOperationRepository — idempotent upload/finalize/delete ops
// ---------------------------------------------------------------------------

export class StorageOperationRepository {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  /**
   * Claim an operation by its unique key. Returns the existing status when
   * already processed (idempotent replay) or inserts a new pending op.
   */
  async begin(
    objectId: string,
    operationType: string,
    operationKey: string,
  ): Promise<
    { readonly kind: 'acquired'; readonly version: number } | { readonly kind: 'replayed' }
  > {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `
INSERT INTO storage_operations (id, object_id, operation_type, operation_key)
VALUES (gen_random_uuid(), $1, $2, $3)
ON CONFLICT (operation_key) DO NOTHING
RETURNING id::text AS id, row_version::text AS row_version`,
      values: [objectId, operationType, operationKey],
    });
    if (rows.length > 0) {
      return { kind: 'acquired', version: Number(rows[0]!['row_version'] ?? 0) };
    }
    return { kind: 'replayed' };
  }

  async complete(operationKey: string, expectedVersion: number): Promise<void> {
    const rows = await this.poolLike.query({
      text: `UPDATE storage_operations SET status = 'completed', completed_at = now(),
row_version = row_version + 1 WHERE operation_key = $1 AND row_version = $2 AND status != 'completed'`,
      values: [operationKey, expectedVersion],
    });
    if (rows.length === 0) throw new Error(`OPERATION_COMPLETION_CONFLICT:${operationKey}`);
  }
}

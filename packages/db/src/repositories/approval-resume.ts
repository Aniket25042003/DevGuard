export type ApprovalResumeState =
  | 'QUEUED' | 'CLAIMED' | 'REVALIDATING' | 'SYNCING_CHECKPOINT' | 'EXECUTING'
  | 'VERIFYING' | 'COMPLETED' | 'RETRY_WAIT' | 'STALE_NOOP' | 'CANCELLED_FENCED'
  | 'DEAD_LETTERED' | 'EXPIRED';

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly resolution: 'approved' | 'rejected' | 'stale';
  readonly resolutionVersion: number;
  readonly resolutionFingerprint: string;
  readonly runId: string;
  readonly runState: string;
  readonly executionGeneration: number;
  readonly cancelledVersion: number;
}

export interface ApprovalStorePort {
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  resumeState(approvalId: string, resolutionVersion: number): Promise<ApprovalResumeState | undefined>;
  setResumeState(approvalId: string, resolutionVersion: number, state: ApprovalResumeState): Promise<void>;
  markExpired(approvalId: string): Promise<void>;
}

type Queryish = {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
};

/**
 * Postgres-backed approval resume state. The approval aggregate remains the
 * source of truth for authorization; this table only records the durable
 * worker progress for a particular resolution version.
 */
export class PostgresApprovalResumeStore implements ApprovalStorePort {
  constructor(private readonly db: Queryish) {}

  async get(approvalId: string): Promise<ApprovalRecord | undefined> {
    const rows = await this.db.query<Record<string, unknown>>({
      text: `
SELECT a.id::text AS approval_id,
       a.status,
       a.row_version::text AS resolution_version,
       a.fingerprint_hash,
       a.expires_at::text AS expires_at,
       a.workflow_run_id::text AS run_id,
       COALESCE(r.status, 'UNKNOWN') AS run_state,
       COALESCE(r.execution_generation, 0)::text AS execution_generation,
       COALESCE(r.cancellation_generation, 0)::text AS cancelled_version
FROM approvals a
LEFT JOIN workflow_runs r ON r.id = a.workflow_run_id
WHERE a.id = $1
LIMIT 1`,
      values: [approvalId],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    const expiresAt = row['expires_at'];
    if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) {
      return {
        approvalId: String(row['approval_id']),
        resolution: 'stale',
        resolutionVersion: Number(row['resolution_version'] ?? 0),
        resolutionFingerprint: String(row['fingerprint_hash'] ?? ''),
        runId: String(row['run_id'] ?? ''),
        runState: String(row['run_state'] ?? 'UNKNOWN').toUpperCase(),
        executionGeneration: Number(row['execution_generation'] ?? 0),
        cancelledVersion: Number(row['cancelled_version'] ?? 0),
      };
    }
    const status = String(row['status'] ?? '').toLowerCase();
    return {
      approvalId: String(row['approval_id']),
      resolution:
        status === 'approved' ? 'approved' : status === 'rejected' || status === 'stale' ? 'stale' : 'stale',
      resolutionVersion: Number(row['resolution_version'] ?? 0),
      resolutionFingerprint: String(row['fingerprint_hash'] ?? ''),
      runId: String(row['run_id'] ?? ''),
      runState: String(row['run_state'] ?? 'UNKNOWN').toUpperCase(),
      executionGeneration: Number(row['execution_generation'] ?? 0),
      cancelledVersion: Number(row['cancelled_version'] ?? 0),
    };
  }

  async resumeState(
    approvalId: string,
    resolutionVersion: number,
  ): Promise<ApprovalResumeState | undefined> {
    const rows = await this.db.query<{ state: string }>({
      text: `SELECT state FROM approval_resume_states
             WHERE approval_id = $1 AND resolution_version = $2`,
      values: [approvalId, resolutionVersion],
    });
    const state = rows[0]?.state;
    return state !== undefined && isResumeState(state) ? state : undefined;
  }

  async setResumeState(
    approvalId: string,
    resolutionVersion: number,
    state: ApprovalResumeState,
  ): Promise<void> {
    await this.db.query({
      text: `INSERT INTO approval_resume_states
               (approval_id, resolution_version, state)
             VALUES ($1, $2, $3)
             ON CONFLICT (approval_id, resolution_version)
             DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      values: [approvalId, resolutionVersion, state],
    });
  }

  async markExpired(approvalId: string): Promise<void> {
    await this.db.query({
      text: `WITH expired AS (
               UPDATE approvals
               SET status = 'expired', resolved_at = COALESCE(resolved_at, now()),
                   updated_at = now(), row_version = row_version + 1
               WHERE id = $1 AND status = 'approved' AND expires_at <= now()
               RETURNING id, row_version
             )
             INSERT INTO approval_transitions
               (id, approval_id, from_status, to_status, actor_type, actor_id, reason_code, command_key)
             SELECT gen_random_uuid(), id, 'approved', 'expired', 'system', 'scheduler',
                    'approval_expired', 'expire:' || id::text || ':' || row_version::text
             FROM expired
             ON CONFLICT (approval_id, command_key) DO NOTHING`,
      values: [approvalId],
    });
  }
}

function isResumeState(value: string): value is ApprovalResumeState {
  return new Set<ApprovalResumeState>([
    'QUEUED', 'CLAIMED', 'REVALIDATING', 'SYNCING_CHECKPOINT', 'EXECUTING',
    'VERIFYING', 'COMPLETED', 'RETRY_WAIT', 'STALE_NOOP', 'CANCELLED_FENCED',
    'DEAD_LETTERED', 'EXPIRED',
  ]).has(value as ApprovalResumeState);
}

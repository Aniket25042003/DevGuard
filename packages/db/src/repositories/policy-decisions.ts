/**
 * CP009 (C030) — durable policy-decision store.
 *
 * Records the policy DECISION for a run before any external side effect. The
 * worker and webhook fail closed until a row exists for a run they would mutate.
 */
export interface PolicyDecisionRecord {
  readonly runId: string;
  readonly policyVersion: string;
  readonly effect: 'allow' | 'deny' | 'require_approval';
  readonly reasonCode: string;
  readonly decidedAtIso: string;
  readonly rowVersion: number;
}

interface Queryish {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

export class PostgresPolicyDecisionStore {
  constructor(private readonly pool: Queryish) {}

  async recordDecision(input: {
    readonly runId: string;
    readonly policyVersion: string;
    readonly effect: 'allow' | 'deny' | 'require_approval';
    readonly reasonCode: string;
  }): Promise<PolicyDecisionRecord> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `INSERT INTO policy_decisions (run_id, policy_version, effect, reason_code)
VALUES ($1, $2, $3, $4)
ON CONFLICT (run_id) DO UPDATE SET
  policy_version = EXCLUDED.policy_version,
  effect = EXCLUDED.effect,
  reason_code = EXCLUDED.reason_code,
  decided_at = now(),
  row_version = policy_decisions.row_version + 1
RETURNING run_id, policy_version, effect, reason_code, decided_at::text AS decided_at, row_version::text AS row_version`,
      values: [input.runId, input.policyVersion, input.effect, input.reasonCode],
    });
    const row = rows[0];
    if (row === undefined) throw new Error('POLICY_DECISION_WRITE_FAILED');
    return {
      runId: String(row['run_id']),
      policyVersion: String(row['policy_version']),
      effect: String(row['effect']) as PolicyDecisionRecord['effect'],
      reasonCode: String(row['reason_code']),
      decidedAtIso: String(row['decided_at'] ?? ''),
      rowVersion: Number(row['row_version']),
    };
  }

  async getDecision(runId: string): Promise<PolicyDecisionRecord | null> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT run_id, policy_version, effect, reason_code, decided_at::text AS decided_at, row_version::text AS row_version
FROM policy_decisions WHERE run_id = $1`,
      values: [runId],
    });
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId: String(row['run_id']),
      policyVersion: String(row['policy_version']),
      effect: String(row['effect']) as PolicyDecisionRecord['effect'],
      reasonCode: String(row['reason_code']),
      decidedAtIso: String(row['decided_at'] ?? ''),
      rowVersion: Number(row['row_version']),
    };
  }
}

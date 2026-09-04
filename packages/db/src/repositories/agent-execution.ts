/** Durable agent session/turn repositories.
 *
 * These repositories intentionally expose only the structural shape consumed
 * by @devguard/agent. Provider payloads and SQL rows never cross this file.
 */
import type { SqlStatement } from '../sql.js';
import type { DevGuardPool } from '../pool.js';

type Queryish = Pick<DevGuardPool, 'query'>;

export interface AgentSessionRecord {
  readonly id: string;
  readonly workflowRunId: string;
  readonly repositoryId: string;
  readonly agentDefinitionId: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly contractSnapshotDigest: string;
  readonly providerSessionId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly status: string;
  readonly currentTurnId?: string | undefined;
  readonly cancellationGeneration: number;
  readonly version: number;
  readonly startedAtIso: string;
  readonly updatedAtIso: string;
  readonly commandKey: string;
}

export interface AgentTurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly purpose: string;
  readonly commandKey: string;
  readonly inputDigest: string;
  readonly toolProfileId: string;
  readonly status: string;
  readonly providerTurnId?: string | undefined;
  readonly providerTerminalReason?: string | undefined;
  readonly finalResponseDigest?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly startedAtIso: string;
  readonly completedAtIso?: string | undefined;
}

const sessionColumns = `s.id::text AS id, s.run_id::text AS workflow_run_id,
  r.repository_id::text AS repository_id, s.agent_definition_id,
  s.agent_version, s.provider, s.contract_snapshot_digest,
  s.provider_session_id, s.provider_thread_id, s.status, s.current_turn_id::text,
  s.cancellation_generation::text, s.row_version::text, s.created_at::text,
  s.updated_at::text, s.command_key`;

const turnColumns = `id::text AS id, session_id::text AS session_id,
  (turn_index + 1)::int AS ordinal, purpose, command_key, input_digest,
  tool_profile_id, status, provider_turn_ref, provider_terminal_reason,
  final_response_digest, error_code, COALESCE(started_at, created_at)::text AS started_at,
  completed_at::text AS completed_at`;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function session(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: String(row['id']),
    workflowRunId: String(row['workflow_run_id']),
    repositoryId: String(row['repository_id']),
    agentDefinitionId: String(row['agent_definition_id']),
    agentVersion: String(row['agent_version']),
    provider: String(row['provider']),
    contractSnapshotDigest: String(row['contract_snapshot_digest']),
    ...(optionalString(row['provider_session_id'])
      ? { providerSessionId: String(row['provider_session_id']) }
      : {}),
    ...(optionalString(row['provider_thread_id'])
      ? { providerThreadId: String(row['provider_thread_id']) }
      : {}),
    status: String(row['status']),
    ...(optionalString(row['current_turn_id'])
      ? { currentTurnId: String(row['current_turn_id']) }
      : {}),
    cancellationGeneration: Number(row['cancellation_generation'] ?? 0),
    version: Number(row['row_version'] ?? 0),
    startedAtIso: String(row['created_at']),
    updatedAtIso: String(row['updated_at']),
    commandKey: String(row['command_key']),
  };
}

function turn(row: Record<string, unknown>): AgentTurnRecord {
  return {
    id: String(row['id']),
    sessionId: String(row['session_id']),
    ordinal: Number(row['ordinal']),
    purpose: String(row['purpose']),
    commandKey: String(row['command_key']),
    inputDigest: String(row['input_digest']),
    toolProfileId: String(row['tool_profile_id']),
    status: String(row['status']),
    ...(optionalString(row['provider_turn_ref'])
      ? { providerTurnId: String(row['provider_turn_ref']) }
      : {}),
    ...(optionalString(row['provider_terminal_reason'])
      ? { providerTerminalReason: String(row['provider_terminal_reason']) }
      : {}),
    ...(optionalString(row['final_response_digest'])
      ? { finalResponseDigest: String(row['final_response_digest']) }
      : {}),
    ...(optionalString(row['error_code']) ? { errorCode: String(row['error_code']) } : {}),
    startedAtIso: String(row['started_at']),
    ...(optionalString(row['completed_at']) ? { completedAtIso: String(row['completed_at']) } : {}),
  };
}

export class PostgresAgentSessionStore {
  constructor(private readonly pool: Queryish) {}

  async get(id: string): Promise<AgentSessionRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${sessionColumns} FROM agent_sessions s
             JOIN workflow_runs r ON r.id = s.run_id
             WHERE s.id = $1::uuid`,
      values: [id],
    });
    return rows[0] === undefined ? undefined : session(rows[0]);
  }

  async findByCommandKey(commandKey: string): Promise<AgentSessionRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${sessionColumns} FROM agent_sessions s
             JOIN workflow_runs r ON r.id = s.run_id
             WHERE s.command_key = $1`,
      values: [commandKey],
    });
    return rows[0] === undefined ? undefined : session(rows[0]);
  }

  async save(
    value: AgentSessionRecord,
    expectedVersion: number,
  ): Promise<{ ok: true; session: AgentSessionRecord } | { ok: false; code: 'VERSION_CONFLICT' }> {
    const statement: SqlStatement = {
      text: `
INSERT INTO agent_sessions
  (id, run_id, agent_definition_id, agent_version, provider,
   contract_snapshot_digest, provider_session_id, provider_thread_id, status,
   current_turn_id, cancellation_generation, command_key, row_version)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
        $10::uuid, $11, $12, 1)
ON CONFLICT (id) DO UPDATE SET
  provider_session_id = EXCLUDED.provider_session_id,
  provider_thread_id = EXCLUDED.provider_thread_id,
  status = EXCLUDED.status,
  current_turn_id = EXCLUDED.current_turn_id,
  cancellation_generation = EXCLUDED.cancellation_generation,
  agent_definition_id = EXCLUDED.agent_definition_id,
  agent_version = EXCLUDED.agent_version,
  contract_snapshot_digest = EXCLUDED.contract_snapshot_digest,
  updated_at = now(),
  row_version = agent_sessions.row_version + 1
WHERE agent_sessions.row_version = $14
RETURNING id::text AS id`,
      values: [
        value.id,
        value.workflowRunId,
        value.agentDefinitionId,
        value.agentVersion,
        value.provider,
        value.contractSnapshotDigest,
        value.providerSessionId ?? null,
        value.providerThreadId ?? null,
        value.status,
        value.currentTurnId ?? null,
        value.cancellationGeneration,
        value.commandKey,
        expectedVersion,
      ],
    };
    const rows = await this.pool.query<Record<string, unknown>>(statement);
    if (rows[0] === undefined) return { ok: false, code: 'VERSION_CONFLICT' };
    const saved = await this.get(value.id);
    return saved === undefined
      ? { ok: false, code: 'VERSION_CONFLICT' }
      : { ok: true, session: saved };
  }
}

export class PostgresAgentTurnStore {
  constructor(private readonly pool: Queryish) {}

  async get(id: string): Promise<AgentTurnRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${turnColumns} FROM agent_turns WHERE id = $1::uuid`,
      values: [id],
    });
    return rows[0] === undefined ? undefined : turn(rows[0]);
  }

  async findByCommandKey(commandKey: string): Promise<AgentTurnRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${turnColumns} FROM agent_turns WHERE command_key = $1`,
      values: [commandKey],
    });
    return rows[0] === undefined ? undefined : turn(rows[0]);
  }

  async countActive(sessionId: string): Promise<number> {
    const rows = await this.pool.query<{ count: string }>({
      text: `SELECT count(*)::text AS count FROM agent_turns
             WHERE session_id = $1::uuid AND status IN
             ('REQUESTED','SUBMITTING','RUNNING','PAUSED','RECONCILING')`,
      values: [sessionId],
    });
    return Number(rows[0]?.count ?? 0);
  }

  async nextOrdinal(sessionId: string): Promise<number> {
    const rows = await this.pool.query<{ ordinal: string }>({
      text: `SELECT (COALESCE(MAX(turn_index), -1) + 2)::text AS ordinal
             FROM agent_turns WHERE session_id = $1::uuid`,
      values: [sessionId],
    });
    return Number(rows[0]?.ordinal ?? 1);
  }

  async save(value: AgentTurnRecord): Promise<void> {
    await this.pool.query({
      text: `
INSERT INTO agent_turns
  (id, session_id, turn_index, purpose, command_key, input_digest, tool_profile_id,
   provider_turn_ref, status, provider_terminal_reason, final_response_digest,
   error_code, started_at, completed_at, row_version)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1)
ON CONFLICT (id) DO UPDATE SET
  provider_turn_ref = EXCLUDED.provider_turn_ref,
  status = EXCLUDED.status,
  provider_terminal_reason = EXCLUDED.provider_terminal_reason,
  final_response_digest = EXCLUDED.final_response_digest,
  error_code = EXCLUDED.error_code,
  started_at = EXCLUDED.started_at,
  completed_at = EXCLUDED.completed_at,
  row_version = agent_turns.row_version + 1,
  updated_at = now()`,
      values: [
        value.id,
        value.sessionId,
        value.ordinal - 1,
        value.purpose,
        value.commandKey,
        value.inputDigest,
        value.toolProfileId,
        value.providerTurnId ?? null,
        value.status,
        value.providerTerminalReason ?? null,
        value.finalResponseDigest ?? null,
        value.errorCode ?? null,
        value.startedAtIso,
        value.completedAtIso ?? null,
      ],
    });
  }
}

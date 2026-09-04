/**
 * Production Postgres-backed API adapters (non-volatile).
 *
 * These adapters satisfy validateReadiness in production when DATABASE_URL is
 * present. They never carry bindingKind:'volatile' and fail closed where a
 * durable projection is not yet fully implemented.
 */
import type {
  AuthorizationEvidencePort,
  AuthorizationEvidenceRecord,
  RepositoryCapability,
} from '@devguard/authorization';
import type { DevGuardPool } from '@devguard/db';
import type { AuditPort, AuditRow } from '../routes/audit.routes.js';
import type { FindingsPort, SecurityFinding } from '../routes/findings.routes.js';
import type { SessionEvent, SessionPort } from '../routes/session.routes.js';
import type { PolicySummaryPort } from '../routes/workflow.routes.js';
import { EventStore } from '@devguard/db';
import { type WorkflowPorts } from './volatile-adapters.js';

type PoolLike = DevGuardPool;

const USER_SUBJECT_PREFIX = 'user:';
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function userIdFromSubjectKey(subjectKey: string): string | undefined {
  if (!subjectKey.startsWith(USER_SUBJECT_PREFIX)) return undefined;
  const candidate = subjectKey.slice(USER_SUBJECT_PREFIX.length);
  return USER_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export class PostgresAuthorizationEvidenceStore implements AuthorizationEvidencePort {
  readonly bindingName = 'authorization_evidence_postgres';

  constructor(private readonly pool: PoolLike) {}

  async append(record: AuthorizationEvidenceRecord): Promise<void> {
    const userId = userIdFromSubjectKey(record.subjectKey);
    if (userId === undefined) {
      // System actors and legacy subject keys are not persisted in this table.
      return;
    }
    await this.pool.query({
      text: `
INSERT INTO repository_access_evidence
  (id, repository_id, user_id, capability, decision, source, snapshot_hash, expires_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz)`,
      values: [
        record.id,
        record.repositoryId,
        userId,
        record.capability,
        record.effect === 'allow' ? 'allow' : 'deny',
        record.source,
        record.providerSnapshotHash ?? null,
        record.expiresAt ?? null,
      ],
    });
  }

  async findFresh(
    subjectKey: string,
    repositoryId: string,
    capability: RepositoryCapability,
    nowMs: number,
  ): Promise<AuthorizationEvidenceRecord | undefined> {
    const userId = userIdFromSubjectKey(subjectKey);
    if (userId === undefined) return undefined;
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT id::text AS id, repository_id::text AS repository_id, user_id::text AS user_id,
       capability, decision, source, snapshot_hash, checked_at::text AS checked_at,
       expires_at::text AS expires_at
FROM repository_access_evidence
WHERE user_id = $1::uuid AND repository_id = $2::uuid AND capability = $3
  AND decision = 'allow' AND (expires_at IS NULL OR expires_at > to_timestamp($4 / 1000.0))
ORDER BY checked_at DESC
LIMIT 1`,
      values: [userId, repositoryId, capability, nowMs],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row['id']),
      repositoryId: String(row['repository_id']),
      subjectKey: `${USER_SUBJECT_PREFIX}${String(row['user_id'])}`,
      capability: String(row['capability']) as RepositoryCapability,
      effect: 'allow',
      reasonCode: 'cached_evidence',
      source: String(row['source']) as AuthorizationEvidenceRecord['source'],
      ...(row['snapshot_hash'] !== null && row['snapshot_hash'] !== undefined
        ? { providerSnapshotHash: String(row['snapshot_hash']) }
        : {}),
      checkedAt: String(row['checked_at']),
      ...(row['expires_at'] !== null && row['expires_at'] !== undefined
        ? { expiresAt: String(row['expires_at']) }
        : {}),
    };
  }
}

export class DurablePolicySummariesAdapter implements PolicySummaryPort {
  readonly bindingName = 'policies_postgres';

  constructor(private readonly pool: PoolLike) {}

  async summaryFor(userId: string): Promise<Array<{ id: string; name: string; enabled: boolean }>> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT r.id::text AS id, r.full_name AS name
FROM repositories r
JOIN user_installation_links uil ON uil.installation_id = r.installation_id
JOIN users u ON u.id = uil.user_id
JOIN repository_policy_heads h ON h.repository_id = r.id
WHERE u.id = $1::uuid OR uil.user_id = $1::uuid
ORDER BY r.full_name`,
      values: [userId],
    });
    return rows.map((row) => ({
      id: String(row['id']),
      name: String(row['name'] ?? 'repository'),
      enabled: true,
    }));
  }
}

export class DurableSessionEventsAdapter implements SessionPort {
  readonly bindingName = 'session_events_postgres';

  private readonly eventStore: EventStore;

  constructor(private readonly pool: PoolLike) {
    this.eventStore = new EventStore(pool);
  }

  async get(
    sessionId: string,
    userId: string,
  ): Promise<{ sessionId: string; state: string; turnCount: number } | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT s.id::text AS session_id, s.status,
       (SELECT count(*)::int FROM agent_turns t WHERE t.session_id = s.id) AS turn_count
FROM agent_sessions s
JOIN workflow_runs r ON r.id = s.run_id
WHERE s.id = $1::uuid AND r.created_by = $2
LIMIT 1`,
      values: [sessionId, userId],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: String(row['session_id']),
      state: String(row['status']),
      turnCount: Number(row['turn_count'] ?? 0),
    };
  }

  async events(sessionId: string, userId: string, limit: number): Promise<SessionEvent[]> {
    const runId = await this.resolveRunId(sessionId, userId);
    if (runId === undefined) return [];
    const rows = await this.eventStore.readAfter(runId, -1, limit);
    return rows.map((row) => this.toSessionEvent(row));
  }

  async eventsAfter(
    sessionId: string,
    userId: string,
    afterSequence: number,
    limit: number,
  ): Promise<SessionEvent[]> {
    const runId = await this.resolveRunId(sessionId, userId);
    if (runId === undefined) return [];
    const rows = await this.eventStore.readAfter(runId, afterSequence, limit);
    return rows.map((row) => this.toSessionEvent(row));
  }

  private async resolveRunId(sessionId: string, userId: string): Promise<string | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT s.run_id::text AS run_id
FROM agent_sessions s
JOIN workflow_runs r ON r.id = s.run_id
WHERE s.id = $1::uuid AND r.created_by = $2
LIMIT 1`,
      values: [sessionId, userId],
    });
    const row = rows[0];
    return row === undefined ? undefined : String(row['run_id']);
  }

  private toSessionEvent(row: {
    readonly sequenceNumber: number;
    readonly eventType: string;
    readonly payloadJson: unknown;
  }): SessionEvent {
    const payload =
      typeof row.payloadJson === 'object' && row.payloadJson !== null
        ? (row.payloadJson as { summary?: unknown })
        : undefined;
    const summary =
      typeof payload?.summary === 'string' && payload.summary.length > 0
        ? payload.summary
        : row.eventType;
    return {
      sequenceNumber: row.sequenceNumber,
      eventType: row.eventType,
      summary,
    };
  }
}

export class DurableFindingsAdapter implements FindingsPort {
  readonly bindingName = 'findings_postgres';

  constructor(private readonly pool: PoolLike) {}

  async listFor(runId: string): Promise<readonly SecurityFinding[]> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT sf.id::text AS id, sf.severity, sf.status, sf.category AS rule
FROM finding_occurrences fo
JOIN security_findings sf ON sf.id = fo.finding_id
WHERE fo.run_id = $1::uuid
ORDER BY sf.severity, sf.id`,
      values: [runId],
    });
    return rows.map((row) => ({
      id: String(row['id']),
      severity: String(row['severity']) as SecurityFinding['severity'],
      status: String(row['status']) as SecurityFinding['status'],
      ...(row['rule'] !== null && row['rule'] !== undefined ? { rule: String(row['rule']) } : {}),
    }));
  }
}

export class DurableAuditAdapter implements AuditPort {
  readonly bindingName = 'audit_postgres';

  constructor(private readonly pool: PoolLike) {}

  async list(userId: string): Promise<{ verified: boolean; rows: readonly AuditRow[] }> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT a.id::text AS id, a.created_at::text AS occurred_at, a.action_type AS change_kind,
       COALESCE(a.metadata_json->>'summary', a.action_type) AS summary
FROM actions a
JOIN workflow_runs r ON r.id = a.run_id
WHERE r.created_by = $1
ORDER BY a.created_at DESC
LIMIT 200`,
      values: [userId],
    });
    return {
      verified: true,
      rows: rows.map((row) => ({
        id: String(row['id']),
        occurredAtIso: String(row['occurred_at']),
        changeKind: String(row['change_kind']),
        summary: String(row['summary']),
      })),
    };
  }
}

/** Command catalog backed by durable action rows; launch/status remain unavailable here. */
export class DurableCommandCatalogAdapter implements WorkflowPorts {
  readonly bindingName = 'workflows_postgres_catalog';

  constructor(private readonly pool: PoolLike) {}

  async launch(): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  > {
    return {
      ok: false,
      code: 'WORKFLOW_UNCONFIGURED',
      detail: 'Use repository-scoped workflow start routes; legacy launch is disabled.',
    };
  }

  async statusOf(): Promise<{ runId: string; state: string } | undefined> {
    return undefined;
  }

  async commandsOf(
    runId: string,
    userId: string,
  ): Promise<
    Array<{
      commandId: string;
      class: string;
      state: string;
      argvRedacted: readonly string[];
      exitCode?: number | null;
    }>
  > {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `
SELECT a.id::text AS id, a.action_type, a.status, a.metadata_json
FROM actions a
JOIN workflow_runs r ON r.id = a.run_id
WHERE a.run_id = $1::uuid AND r.created_by = $2
ORDER BY a.created_at ASC`,
      values: [runId, userId],
    });
    return rows.map((row) => ({
      commandId: String(row['id']),
      class: String(row['action_type']),
      state: String(row['status']),
      argvRedacted: [],
      exitCode: null,
    }));
  }
}

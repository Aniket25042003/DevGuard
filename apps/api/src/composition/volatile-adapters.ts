/**
 * CP002 §23/§8 — named volatile (in-memory) adapters used ONLY in `test` (or
 * `development` behind DEVGUARD_ALLOW_VOLATILE_AUTH=true). Each carries a
 * `bindingKind:'volatile'` marker so `validateReadiness` can refuse them
 * outside an approved environment, and a `bindingName` for diagnostics.
 *
 * Nothing here is ever an empty store that pretends success: `test` uses
 * in-memory fakes; every durable environment gets the fail-closed
 * `UnavailableWorkflowAdapter` until a real adapter binds (CP006/CP007/CP011).
 */
import type { TimestampIso, WorkflowStatus } from '@devguard/contracts';
import { idempotencyKeyConflict } from '@devguard/errors';
import type { ApiTokenRecord, ApiTokenRepository } from '@devguard/auth';
import type { CommandBusPersistencePort, CreateQueuedRunInput } from '@devguard/workflows';
import type {
  CommandCatalogPort,
  PolicySummaryPort,
  WorkflowLaunchPort,
  WorkflowStatusPort,
} from '../routes/workflow.routes.js';
import type { RepositoryCatalogPort, WebhookAcceptancePort } from '../routes/github.routes.js';
import type { ArtifactPort } from '../routes/artifact.routes.js';
import type { AuditPort } from '../routes/audit.routes.js';
import type { FindingsPort } from '../routes/findings.routes.js';
import type { SessionEvent, SessionPort } from '../routes/session.routes.js';
import type { ApprovalPort } from '../routes/approval.routes.js';
import { VOLATILE_BINDING_KIND, type VolatileBindingMarker } from './bindings.js';

export type WorkflowPorts = WorkflowLaunchPort & WorkflowStatusPort & CommandCatalogPort;

/** Fail-closed default for durable environments until CP006/CP007 wire a real bus. */
export class UnavailableWorkflowAdapter implements WorkflowPorts {
  readonly bindingKind = undefined;
  readonly bindingName = 'workflows_unavailable';

  async launch(
    _input: { workflowType: string; version: string; idempotencyKey: string; input: unknown },
    _userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  > {
    return {
      ok: false,
      code: 'WORKFLOW_UNCONFIGURED',
      detail: 'No durable workflow adapter is bound for this environment yet.',
    };
  }

  async statusOf(_runId: string, _userId: string) {
    return undefined;
  }

  async commandsOf(_runId: string, _userId: string): Promise<never[]> {
    return [];
  }
}

interface VolatileRun {
  readonly runId: string;
  readonly userId: string;
  readonly state: WorkflowStatus;
  readonly workflowType: string;
  readonly version: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
}

/** In-memory workflow launch/status/command projection (test only). */
export class VolatileWorkflowService implements WorkflowPorts, VolatileBindingMarker {
  readonly bindingKind = VOLATILE_BINDING_KIND;
  readonly bindingName = 'workflows_in_memory';

  readonly runs = new Map<string, VolatileRun>();
  private counter = 0;

  async launch(
    input: { workflowType: string; version: string; idempotencyKey: string; input: unknown },
    userId: string,
  ): Promise<
    { ok: true; runId: string; replayed: boolean } | { ok: false; code: string; detail: string }
  > {
    const existing = [...this.runs.values()].find(
      (run) => run.userId === userId && run.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        JSON.stringify(existing.input) === JSON.stringify(input.input) &&
        existing.workflowType === input.workflowType &&
        existing.version === input.version
      ) {
        return { ok: true, runId: existing.runId, replayed: true };
      }
      return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', detail: 'Idempotency key was reused.' };
    }
    this.counter += 1;
    const runId = crypto.randomUUID();
    this.runs.set(runId, {
      runId,
      userId,
      state: 'queued',
      workflowType: input.workflowType,
      version: input.version,
      idempotencyKey: input.idempotencyKey,
      input: input.input,
    });
    return { ok: true, runId, replayed: false };
  }

  async statusOf(runId: string, userId: string) {
    const run = this.runs.get(runId);
    return run !== undefined && run.userId === userId ? { runId, state: run.state } : undefined;
  }

  async commandsOf(_runId: string, _userId: string): Promise<never[]> {
    return [];
  }
}

/** In-memory webhook acceptance (test only). */
export class VolatileWebhookAcceptance implements WebhookAcceptancePort, VolatileBindingMarker {
  readonly bindingKind = VOLATILE_BINDING_KIND;
  readonly bindingName = 'webhooks_in_memory';
  readonly claimed = new Map<string, number>();
  private readonly replayWindowMs = 5 * 60 * 1000;

  async accept(input: {
    deliveryId: string;
    event: string;
    payloadJson: string;
    headers: { signature: string };
  }): Promise<{ accepted: boolean; replay?: boolean }> {
    void input.event;
    void input.payloadJson;
    void input.headers;
    const now = Date.now();
    for (const [deliveryId, claimedAt] of this.claimed) {
      if (now - claimedAt >= this.replayWindowMs) this.claimed.delete(deliveryId);
    }
    const replay = this.claimed.has(input.deliveryId);
    this.claimed.set(input.deliveryId, now);
    return { accepted: true, replay };
  }
}

/** Truthful empty policy summary (test only) — no durable store yet. */
export const VolatilePolicySummaries: PolicySummaryPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'policies_in_memory',
  async summaryFor(_userId: string) {
    return [];
  },
};

/** Truthful empty repository catalog for an environment with no linkages. */
export const VolatileRepositoryCatalog: RepositoryCatalogPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'repository_catalog_in_memory',
  async listFor(_userId: string) {
    return [];
  },
};

/** Safe empty artifact projection (test only). */
export const VolatileArtifacts: ArtifactPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'artifacts_in_memory',
  async listFor(_runId: string) {
    return [];
  },
  async getSafe(_id: string) {
    return undefined;
  },
};

/** Never-present unverified audit projection (test only). */
export const VolatileAudit: AuditPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'audit_in_memory',
  async list(_userId: string) {
    return { verified: false, rows: [] };
  },
};

/** Empty security findings projection (test only). */
export const VolatileFindings: FindingsPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'findings_in_memory',
  async listFor(_runId: string) {
    return [];
  },
};

/** Empty session/event projection (test only). */
export const VolatileSessionEvents: SessionPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'sessions_events_in_memory',
  async get(_sessionId: string, _userId: string) {
    return undefined;
  },
  async events(_sessionId: string, _userId: string, _limit: number) {
    return [];
  },
  async eventsAfter(_sessionId: string, _userId: string, _afterSequence: number, _limit: number): Promise<SessionEvent[]> {
    return [];
  },
};

/** Refusing approval store (test only) — approval wiring lands in CP009. */
export const VolatileApprovals: ApprovalPort & VolatileBindingMarker = {
  bindingKind: VOLATILE_BINDING_KIND,
  bindingName: 'approvals_in_memory',
  async listFor(_runId: string, _userId: string) {
    return [];
  },
  async resolve(_runId, _approvalId, _resolution, _userId) {
    return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'no approval store wired' };
  },
};

/** In-memory CLI/API token store (test only) — durable store lands in CP004/db. */
export class VolatileApiTokenRepository implements ApiTokenRepository, VolatileBindingMarker {
  readonly bindingKind = VOLATILE_BINDING_KIND;
  readonly bindingName = 'api_tokens_in_memory';

  private readonly rows = new Map<string, ApiTokenRecord>();

  async insert(record: ApiTokenRecord): Promise<void> {
    this.rows.set(record.tokenId, { ...record });
  }

  async findByTokenHash(tokenHash: string): Promise<ApiTokenRecord | undefined> {
    for (const record of this.rows.values()) {
      if (record.tokenHash === tokenHash) return { ...record };
    }
    return undefined;
  }

  async listByOwner(userId: string): Promise<readonly ApiTokenRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...record }));
  }

  async revoke(tokenId: string, userId: string, revokedAt: TimestampIso): Promise<void> {
    const record = this.rows.get(tokenId);
    if (record !== undefined && record.userId === userId && record.revokedAt === undefined) {
      this.rows.set(tokenId, { ...record, revokedAt, rowVersion: record.rowVersion + 1 });
    }
  }
}

/**
 * In-memory command persistence (test only). Dedupes by idempotency hash like
 * the durable port, but is not durable — flagged volatile so production refuses it.
 */
export class VolatileCommandBusPersistencePort
  implements CommandBusPersistencePort, VolatileBindingMarker
{
  readonly bindingKind = VOLATILE_BINDING_KIND;
  readonly bindingName = 'command_bus_in_memory';

  private readonly byHash = new Map<string, { runId: string; fingerprint: string }>();

  async createQueuedRun(
    input: CreateQueuedRunInput,
  ): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  > {
    const existing = this.byHash.get(input.idempotencyKeyHash);
    if (existing !== undefined) {
      // Mirror the durable port: an identical replay dedupes; a mismatched
      // reuse of the same key is a conflict, never a silent wrong-run return.
      if (existing.fingerprint === input.requestFingerprint) {
        return { outcome: 'replayed', runId: existing.runId };
      }
      throw idempotencyKeyConflict(new Error('idempotency_key_reused_with_different_request'));
    }
    this.byHash.set(input.idempotencyKeyHash, {
      runId: input.runId,
      fingerprint: input.requestFingerprint,
    });
    return { outcome: 'created', runId: input.runId };
  }
}

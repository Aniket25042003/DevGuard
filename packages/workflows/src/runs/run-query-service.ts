/**
 * CP007 — Webhook/workflow query + cancel use cases (C067 GET/LIST/CANCEL).
 *
 * Thin read/cancel surface over the durable run store. The route layer maps
 * `RunRow` to the frozen `WorkflowRunDtoV1`; the store itself stays in
 * `@devguard/db`. Cancel uses an optimistic-concurrency CAS on the run's
 * row version (If-Match/ETag) and only allows pre-flight states.
 */
export interface RunRow {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowType: string;
  readonly status: string;
  readonly triggerType: string;
  readonly originSurface: string;
  readonly definitionVersion: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly startedAtIso?: string | undefined;
  readonly completedAtIso?: string | undefined;
  readonly rowVersion: number;
  readonly pullRequestNumber?: number | undefined;
  readonly sessionId?: string | undefined;
}

export type OriginSurfaceV1 = 'web' | 'cli' | 'github_comment' | 'github_event' | 'schedule';
export type TriggerTypeV1 = 'manual' | 'webhook' | 'api' | 'schedule';

export interface WorkflowRunStorePort {
  getDetail(id: string): Promise<RunRow | null>;
  list(options: {
    readonly repositoryId: string;
    readonly limit: number;
    readonly cursor?: { readonly createdAtIso: string; readonly id: string } | undefined;
    readonly triggerType?: TriggerTypeV1 | undefined;
    readonly originSurface?: OriginSurfaceV1 | undefined;
    readonly pullRequestNumber?: number | undefined;
  }): Promise<RunRow[]>;
  cancel(id: string, expectedVersion: number): Promise<RunRow>;
}

export interface Cursor {
  readonly createdAtIso: string;
  readonly id: string;
}

export interface RunListPage {
  readonly runs: readonly RunRow[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor | undefined;
}

export type CancelOutcome =
  | { readonly ok: true; readonly run: RunRow }
  | {
      readonly ok: false;
      readonly code: 'WORKFLOW_UNKNOWN' | 'WORKFLOW_NOT_CANCELLABLE' | 'PRECONDITION_FAILED';
    };

export const DEFAULT_RUN_LIMIT = 50;
export const MAX_RUN_LIMIT = 100;

export class WorkflowQueryService {
  constructor(private readonly deps: { readonly runs: WorkflowRunStorePort }) {}

  async listRuns(input: {
    readonly repositoryId: string;
    readonly limit?: number | undefined;
    readonly cursor?: Cursor | undefined;
    readonly triggerType?: TriggerTypeV1 | undefined;
    readonly originSurface?: OriginSurfaceV1 | undefined;
    readonly pullRequestNumber?: number | undefined;
  }): Promise<RunListPage> {
    const requested = Math.min(Math.max(input.limit ?? DEFAULT_RUN_LIMIT, 1), MAX_RUN_LIMIT);
    const rows = await this.deps.runs.list({
      repositoryId: input.repositoryId,
      limit: requested + 1,
      cursor: input.cursor,
      ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
      ...(input.originSurface !== undefined ? { originSurface: input.originSurface } : {}),
      ...(input.pullRequestNumber !== undefined
        ? { pullRequestNumber: input.pullRequestNumber }
        : {}),
    });
    const hasMore = rows.length > requested;
    const page = hasMore ? rows.slice(0, requested) : rows;
    const last = page[page.length - 1];
    return {
      runs: page,
      hasMore,
      ...(last !== undefined
        ? { nextCursor: { createdAtIso: last.createdAtIso, id: last.id } }
        : {}),
    };
  }

  async getRun(runId: string): Promise<RunRow | null> {
    return this.deps.runs.getDetail(runId);
  }

  /** Cooperative cancel: queued/waiting_for_approval → cancelled, IF version matches. */
  async cancel(runId: string, expectedVersion: number): Promise<CancelOutcome> {
    const existing = await this.deps.runs.getDetail(runId);
    if (existing === null) return { ok: false, code: 'WORKFLOW_UNKNOWN' };
    if (existing.status !== 'queued' && existing.status !== 'waiting_for_approval') {
      return { ok: false, code: 'WORKFLOW_NOT_CANCELLABLE' };
    }
    try {
      const run = await this.deps.runs.cancel(runId, expectedVersion);
      return { ok: true, run };
    } catch {
      return { ok: false, code: 'PRECONDITION_FAILED' };
    }
  }
}

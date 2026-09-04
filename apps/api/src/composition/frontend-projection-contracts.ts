/**
 * Frontend projection ports for the operational control plane.
 *
 * This module deliberately contains no in-memory fallback and is not wired
 * into the HTTP assembly until a durable projection store is available. The
 * API can therefore adopt the new workspace/run surfaces incrementally while
 * keeping unavailable dependencies explicit to callers.
 */

export type ControlPlaneRunStatus =
  | 'queued'
  | 'dispatch_pending'
  | 'running'
  | 'waiting_for_approval'
  | 'resuming'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'unavailable'
  | 'cancelling'
  | 'cancelled';

export type ProjectionReadiness = 'healthy' | 'degraded' | 'unavailable' | 'disabled' | 'unknown';

export interface WorkspaceActivityRow {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly workflowRunId: string;
  readonly workflowType: string;
  readonly targetLabel?: string | undefined;
  readonly originSurface: string;
  readonly status: ControlPlaneRunStatus;
  readonly updatedAt: string;
  readonly requestId: string;
}

export interface WorkspaceActivityProjection {
  readonly rows: readonly WorkspaceActivityRow[];
  readonly cursor?: string | undefined;
  readonly projectionVersion: string;
  readonly readiness: Readonly<Record<string, ProjectionReadiness>>;
}

export interface WorkspaceActivityQuery {
  readonly principalId: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/** Durable read-model seam for GET /api/v1/activity?scope=workspace. */
export interface WorkspaceActivityProjectionPort {
  listForPrincipal(query: WorkspaceActivityQuery): Promise<WorkspaceActivityProjection>;
}

/** Stable error shape used when a projection dependency is not bound. */
export interface ProjectionUnavailable {
  readonly code: 'DEPENDENCY_UNAVAILABLE';
  readonly retryable: true;
  readonly requestId: string;
  readonly detail: string;
}

export function projectionUnavailable(requestId: string, detail: string): ProjectionUnavailable {
  return {
    code: 'DEPENDENCY_UNAVAILABLE',
    retryable: true,
    requestId,
    detail,
  };
}

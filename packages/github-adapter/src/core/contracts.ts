/**
 * C018 §8/§10 — operation descriptors, request context, response meta,
 * rate budget, and typed results.
 *
 * Provider types never cross this boundary; all responses are validated and
 * normalized. Writes additionally require an unforgeable AuthorizedActionContext
 * issued by the action gateway (C030).
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type CallSafety = 'read' | 'write';

export interface GitHubOperation<I = unknown, O = unknown> {
  /** Stable normalized operation ID (not a raw URL path). */
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly safety: CallSafety;
  /** Path template with {placeholders}; never user-concatenated. */
  readonly pathTemplate: string;
  readonly inputSchema: { parse(input: unknown): I };
  readonly outputSchema: { parse(output: unknown): O };
  readonly successStatuses: readonly number[];
  readonly supportsConditional: boolean;
  readonly paginationStyle: 'none' | 'link-header' | 'cursor-body';
  /** Only provably safe reads get automatic retries. */
  readonly retrySafe: boolean;
}

export interface GitHubRequestContext {
  readonly operationId: string;
  readonly correlationId: string;
  readonly installationId: string;
  readonly repositoryScope?: string | undefined;
  readonly actorId?: string | undefined;
  readonly deadlineMs?: number | undefined;
  readonly attempt: number;
  readonly apiVersion: string;
  /** Present for writes only; issued by the action gateway (C030). */
  readonly authorizationContext?: { readonly digest: string } | undefined;
}

export interface GitHubRateInfo {
  readonly limit: number;
  readonly remaining: number;
  readonly resetEpochSec: number;
}

export interface GitHubResponseMeta {
  readonly githubRequestId?: string | undefined;
  readonly status: number;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly rate?: GitHubRateInfo | undefined;
  readonly linkHeader?: string | undefined;
  readonly receivedAtMs: number;
}

export type GitHubAdapterErrorKind =
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'SCHEMA_MISMATCH'
  | 'OUTCOME_UNKNOWN'
  | 'UNAUTHORIZED_WRITE';

export interface GitHubAdapterError {
  readonly kind: GitHubAdapterErrorKind;
  readonly operationId: string;
  readonly status?: number | undefined;
  readonly message: string;
  readonly retryAfterMs?: number | undefined;
  readonly githubRequestId?: string | undefined;
}

export type GitHubResult<T> =
  | { ok: true; value: T; meta: GitHubResponseMeta; notModified?: false }
  | { ok: true; notModified: true; meta: GitHubResponseMeta }
  | { ok: false; error: GitHubAdapterError };

/** Unforgeable authorization context from the action gateway (C030). */
export interface AuthorizedActionContext {
  readonly decisionId: string;
  readonly operationKey: string;
  readonly actionFingerprint: string;
  /** HMAC binding the decision to the exact canonical operation digest. */
  readonly digest: string;
}

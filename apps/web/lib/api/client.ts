import {
  authSessionResponseSchema,
  commandReceiptSchema,
  IDEMPOTENCY_KEY_HEADER,
  LAST_EVENT_ID_HEADER,
  workflowRunDtoSchema,
  type AuthSessionResponse,
  type CanonicalCommandId,
  type CommandReceiptV1,
  type OriginSurface,
  type TriggerTypeV1,
  type WorkflowRunDtoV1,
} from '@devguard/api-contracts';
import { z } from 'zod';
import { CSRF_HEADER, readCsrfToken } from './csrf';
import { decodeApiError, DevGuardApiError } from './errors';
import { decodeSseStream, type SseFrame } from './sse';

const API_PREFIX = '/api/v1';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface RequestOptions {
  readonly signal: AbortSignal;
  readonly idempotencyKey?: string | undefined;
  readonly ifMatch?: string | undefined;
  readonly lastEventId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CommandDescriptor {
  readonly workflowId: CanonicalCommandId | string;
  readonly inputSchemaId: string;
}

export interface RepositorySummary {
  readonly id: string;
  readonly name: string;
  readonly owner?: string | undefined;
  readonly fullName?: string | undefined;
  readonly role?: string | undefined;
  readonly status?: string | undefined;
  readonly defaultBranch?: string | undefined;
  readonly installationId?: string | undefined;
  readonly githubRepositoryId?: string | undefined;
  readonly connected?: boolean | undefined;
  readonly visibility?: 'public' | 'private' | undefined;
  readonly archived?: boolean | undefined;
}

export interface InstallationSummary {
  readonly id: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly status: string;
  readonly githubInstallationId?: string | number | undefined;
}

export interface ApprovalSummary {
  readonly approvalId: string;
  readonly state: string;
  readonly reason?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly actionType?: string | undefined;
  readonly riskClass?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly rationaleSummary?: string | undefined;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly state: string;
  readonly turnCount: number;
}

export interface TimelineEvent {
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly summary: string;
  readonly eventId?: string | undefined;
}

export interface SafeArtifact {
  readonly id: string;
  readonly path?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly scanState: 'SAFE';
}

export interface SecurityFinding {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
  readonly rule?: string | undefined;
}

export interface PolicyDocument {
  readonly schemaVersion: 1;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly autonomy: { readonly level: 'assist' | 'developer' | 'trusted' | 'autonomous' };
  readonly triggers: Readonly<Record<string, readonly string[]>>;
  readonly manualCommands: readonly string[];
  readonly actions: {
    readonly allow: readonly string[];
    readonly requireApproval: readonly string[];
    readonly deny: readonly string[];
  };
  readonly validation: { readonly obligations: readonly string[] };
  readonly limits: {
    readonly maxFilesChanged: number;
    readonly maxIterations: number;
    readonly maxRuntimeMinutes: number;
  };
}

export interface PolicyActive {
  readonly document: PolicyDocument;
  readonly activeVersion: number;
  readonly etag: string;
  readonly source: 'saved' | 'defaults';
}

export interface PolicyValidationResult {
  readonly canonical: PolicyDocument;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
  readonly dangerChanges: readonly string[];
  readonly draftDigest: string;
}

export interface PolicyVersionMeta {
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly canonicalHash: string;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly authorLogin: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly draft: boolean;
}

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly authorLogin: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly labels: readonly string[];
}

export interface GitRefSummary {
  readonly name: string;
  readonly commitSha: string;
  readonly isDefault: boolean;
  readonly protected: boolean;
}

export interface RepositoryFindingSummary {
  readonly id: string;
  readonly severity: string;
  readonly status: string;
  readonly title: string;
  readonly rule?: string | undefined;
  readonly filePath?: string | undefined;
  readonly autoFixable: boolean;
}

export interface HealthReady {
  readonly ready: boolean;
  readonly level: string;
  readonly probes: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly critical: boolean;
  }[];
}

export interface PreflightStatus {
  readonly database: boolean;
  readonly redis: boolean;
  readonly trueforge: boolean;
  readonly sandbox: boolean;
  readonly github: boolean;
}

export interface WorkflowListPage {
  readonly runs: readonly WorkflowRunDtoV1[];
  readonly hasMore: boolean;
  readonly nextCursor?: string | undefined;
}

export interface SubmitCommandInput {
  readonly commandId: string;
  readonly definitionVersion: string;
  readonly input: unknown;
  readonly originSurface: 'web';
}

export type FetchLike = typeof fetch;

export interface DevGuardApiClientOptions {
  readonly fetchImpl?: FetchLike | undefined;
  readonly getCookieHeader?: (() => string | undefined) | undefined;
  readonly now?: (() => number) | undefined;
}

const commandDescriptorSchema = z
  .object({
    workflowId: z.string().min(1).max(80),
    inputSchemaId: z.string().min(1).max(128),
  })
  .passthrough();

const repositorySummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().optional(),
    fullName: z.string().optional(),
    role: z.string().optional(),
    status: z.string().optional(),
    defaultBranch: z.string().optional(),
    installationId: z.string().optional(),
    githubRepositoryId: z.string().optional(),
    connected: z.boolean().optional(),
    visibility: z.enum(['public', 'private']).optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const installationSummarySchema = z
  .object({
    id: z.string().min(1),
    accountLogin: z.string().min(1),
    accountType: z.string().min(1),
    status: z.string().min(1),
    githubInstallationId: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const approvalSummarySchema = z
  .object({
    approvalId: z.string().min(1),
    state: z.string().min(1),
    reason: z.string().optional(),
    repositoryId: z.string().optional(),
    workflowRunId: z.string().optional(),
    actionType: z.string().optional(),
    riskClass: z.string().optional(),
    expiresAt: z.string().optional(),
    rationaleSummary: z.string().optional(),
  })
  .passthrough();

const timelineEventSchema = z
  .object({
    sequenceNumber: z.number().int(),
    eventType: z.string(),
    summary: z.string(),
    eventId: z.string().optional(),
  })
  .passthrough();

function newRequestId(now: () => number): string {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString(16)
    .padStart(5, '0');
  return `web-${now().toString(36)}-${rand}`;
}

function joinUrl(path: string, query?: Record<string, string | undefined>): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = `${API_PREFIX}${suffix}`;
  if (query === undefined) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const encoded = params.toString();
  return encoded === '' ? url : `${url}?${encoded}`;
}

/**
 * Single browser HTTP/SSE boundary (C089). Feature modules must call methods
 * here instead of concatenating `/api/v1` URLs or sending `Authorization`.
 */
export class DevGuardApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly getCookieHeader: () => string | undefined;
  private readonly now: () => number;

  constructor(options: DevGuardApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.getCookieHeader =
      options.getCookieHeader ??
      (() => (typeof document === 'undefined' ? undefined : document.cookie));
    this.now = options.now ?? (() => Date.now());
  }

  loginHref(returnTo: string): string {
    const safe =
      returnTo.startsWith('/') && !returnTo.startsWith('//') && returnTo !== '/'
        ? returnTo
        : '/repositories';
    return joinUrl('/auth/login', { returnTo: safe });
  }

  readonly auth = {
    session: (options: RequestOptions): Promise<AuthSessionResponse> =>
      this.requestJson('GET', '/auth/session', { options, schema: authSessionResponseSchema }),
    logout: (options: RequestOptions): Promise<void> =>
      this.requestEmpty('POST', '/auth/logout', { options }),
  };

  readonly health = {
    live: (options: RequestOptions): Promise<{ status: string }> =>
      this.requestJson('GET', '/health/live', {
        options,
        schema: z.object({ status: z.string() }),
      }),
    ready: (options: RequestOptions): Promise<HealthReady> =>
      this.requestJson('GET', '/health/ready', {
        options,
        schema: z
          .object({
            ready: z.boolean(),
            level: z.string(),
            probes: z.array(z.object({ name: z.string(), ok: z.boolean(), critical: z.boolean() })),
          })
          .passthrough(),
      }),
    preflight: (options: RequestOptions): Promise<PreflightStatus> =>
      this.requestJson('GET', '/diagnostics/preflight', {
        options,
        schema: z
          .object({
            preflight: z.object({
              database: z.boolean(),
              redis: z.boolean(),
              trueforge: z.boolean(),
              sandbox: z.boolean(),
              github: z.boolean(),
            }),
          })
          .transform((value) => value.preflight),
      }),
  };

  readonly repositories = {
    list: (options: RequestOptions): Promise<readonly RepositorySummary[]> =>
      this.requestJson('GET', '/repositories', {
        options,
        schema: z
          .union([
            z.object({ repositories: z.array(repositorySummarySchema) }),
            z.object({ data: z.object({ repositories: z.array(repositorySummarySchema) }) }),
          ])
          .transform((value) =>
            'repositories' in value ? value.repositories : value.data.repositories,
          ),
      }),
    get: (repositoryId: string, options: RequestOptions): Promise<RepositorySummary> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}`, {
        options,
        schema: z
          .union([
            repositorySummarySchema,
            z.object({ repository: repositorySummarySchema }),
            z.object({ data: repositorySummarySchema }),
          ])
          .transform((value) =>
            'id' in value ? value : 'repository' in value ? value.repository : value.data,
          ),
      }),
    connect: (
      body: {
        readonly installationId: string;
        readonly githubRepositoryId: string;
        readonly owner: string;
        readonly name: string;
        readonly defaultBranch?: string | undefined;
        readonly visibility?: 'public' | 'private' | undefined;
      },
      options: RequestOptions,
    ): Promise<RepositorySummary> =>
      this.requestJson('POST', '/repositories', {
        options,
        body,
        schema: z
          .union([
            repositorySummarySchema,
            z.object({ repository: repositorySummarySchema }),
            z.object({ data: repositorySummarySchema }),
          ])
          .transform((value) =>
            'id' in value ? value : 'repository' in value ? value.repository : value.data,
          ),
      }),
    disconnect: (repositoryId: string, options: RequestOptions): Promise<RepositorySummary> =>
      this.requestJson('POST', `/repositories/${encodeURIComponent(repositoryId)}/disconnect`, {
        options,
        schema: z
          .union([
            repositorySummarySchema,
            z.object({ repository: repositorySummarySchema }),
            z.object({ data: repositorySummarySchema }),
          ])
          .transform((value) =>
            'id' in value ? value : 'repository' in value ? value.repository : value.data,
          ),
      }),
    health: (
      repositoryId: string,
      options: RequestOptions,
    ): Promise<{ status: string; checkedAt?: string | undefined }> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/health`, {
        options,
        schema: z
          .object({
            status: z.string(),
            checkedAt: z.string().optional(),
          })
          .passthrough(),
      }),
  };

  readonly github = {
    installations: (options: RequestOptions): Promise<readonly InstallationSummary[]> =>
      this.requestJson('GET', '/github/installations', {
        options,
        schema: z
          .union([
            z.object({ installations: z.array(installationSummarySchema) }),
            z.object({ data: z.object({ installations: z.array(installationSummarySchema) }) }),
          ])
          .transform((value) =>
            'installations' in value ? value.installations : value.data.installations,
          ),
      }),
    installationRepositories: (
      installationId: string,
      options: RequestOptions,
      query?: { readonly cursor?: string; readonly q?: string },
    ): Promise<{
      readonly repositories: readonly RepositorySummary[];
      readonly nextCursor?: string | undefined;
    }> =>
      this.requestJson(
        'GET',
        `/github/installations/${encodeURIComponent(installationId)}/repositories`,
        {
          options,
          query: { cursor: query?.cursor, q: query?.q },
          schema: z
            .object({
              repositories: z.array(repositorySummarySchema),
              nextCursor: z.string().optional(),
            })
            .passthrough(),
        },
      ),
    startInstallation: (options: RequestOptions): Promise<{ readonly installUrl: string }> =>
      this.requestJson('POST', '/github/installations/intents', {
        options,
        body: { returnTo: '/settings/github' },
        schema: z.object({ installUrl: z.string().url() }),
      }),
    completeInstallation: (
      githubInstallationId: string,
      options: RequestOptions,
    ): Promise<{ readonly installationId: string; readonly accountLogin: string }> =>
      this.requestJson('POST', '/github/installations/complete', {
        options,
        body: { githubInstallationId },
        schema: z.object({
          installationId: z.string(),
          accountLogin: z.string(),
        }),
      }),
    disconnectInstallation: (
      installationId: string,
      options: RequestOptions,
    ): Promise<{ readonly disconnected: boolean; readonly installationId: string }> =>
      this.requestJson(
        'POST',
        `/github/installations/${encodeURIComponent(installationId)}/disconnect`,
        {
          options,
          schema: z.object({
            disconnected: z.boolean(),
            installationId: z.string(),
          }),
        },
      ),
  };

  readonly commands = {
    list: (repositoryId: string, options: RequestOptions): Promise<readonly CommandDescriptor[]> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/commands`, {
        options,
        schema: z
          .union([
            z.object({ data: z.object({ commands: z.array(commandDescriptorSchema) }) }),
            z.object({ commands: z.array(commandDescriptorSchema) }),
          ])
          .transform((value) => ('commands' in value ? value.commands : value.data.commands)),
      }),
    submit: (
      repositoryId: string,
      input: SubmitCommandInput,
      options: RequestOptions,
    ): Promise<CommandReceiptV1> =>
      this.requestJson('POST', `/repositories/${encodeURIComponent(repositoryId)}/commands`, {
        options,
        body: input,
        schema: z
          .union([z.object({ data: commandReceiptSchema }), commandReceiptSchema])
          .transform((value) => ('data' in value ? value.data : value)),
      }),
  };

  readonly workflows = {
    list: (
      repositoryId: string,
      options: RequestOptions,
      filters?: {
        readonly originSurface?: OriginSurface | undefined;
        readonly triggerType?: TriggerTypeV1 | undefined;
        readonly pullRequestNumber?: number | undefined;
        readonly status?: string | undefined;
        readonly cursor?: string | undefined;
        readonly limit?: number | undefined;
      },
    ): Promise<WorkflowListPage> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/workflows`, {
        options,
        query: {
          originSurface: filters?.originSurface,
          triggerType: filters?.triggerType,
          pullRequestNumber:
            filters?.pullRequestNumber !== undefined
              ? String(filters.pullRequestNumber)
              : undefined,
          status: filters?.status,
          cursor: filters?.cursor,
          limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
        },
        schema: z
          .object({
            data: z.object({
              runs: z.array(workflowRunDtoSchema),
              hasMore: z.boolean(),
              nextCursor: z.string().optional(),
            }),
          })
          .transform((value) => value.data),
      }),
    get: (runId: string, options: RequestOptions): Promise<WorkflowRunDtoV1> =>
      this.requestJson('GET', `/workflows/${encodeURIComponent(runId)}`, {
        options,
        schema: z.object({ data: workflowRunDtoSchema }).transform((value) => value.data),
      }),
    cancel: (runId: string, options: RequestOptions): Promise<WorkflowRunDtoV1> =>
      this.requestJson('POST', `/workflows/${encodeURIComponent(runId)}/cancel`, {
        options,
        schema: z.object({ data: workflowRunDtoSchema }).transform((value) => value.data),
      }),
  };

  readonly sessions = {
    get: (sessionId: string, options: RequestOptions): Promise<SessionSummary> =>
      this.requestJson('GET', `/sessions/${encodeURIComponent(sessionId)}`, {
        options,
        schema: z.object({
          sessionId: z.string(),
          state: z.string(),
          turnCount: z.number(),
        }),
      }),
    listEvents: (sessionId: string, options: RequestOptions): Promise<readonly TimelineEvent[]> =>
      this.requestJson('GET', `/sessions/${encodeURIComponent(sessionId)}/events`, {
        options,
        schema: z
          .object({ events: z.array(timelineEventSchema) })
          .transform((value) => value.events),
      }),
    openEventStream: (
      sessionId: string,
      options: RequestOptions,
      onFrame: (frame: SseFrame) => void,
    ): Promise<void> =>
      this.openSse(`/sessions/${encodeURIComponent(sessionId)}/events`, options, onFrame),
  };

  readonly approvals = {
    list: (
      options: RequestOptions,
      filters?: {
        readonly status?: string;
        readonly repositoryId?: string;
        readonly limit?: number;
      },
    ): Promise<readonly ApprovalSummary[]> =>
      this.requestJson('GET', '/approvals', {
        options,
        query: {
          status: filters?.status,
          repositoryId: filters?.repositoryId,
          limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
        },
        schema: z
          .object({ approvals: z.array(approvalSummarySchema) })
          .transform((value) => value.approvals),
      }),
    listForRun: (runId: string, options: RequestOptions): Promise<readonly ApprovalSummary[]> =>
      this.requestJson('GET', `/workflows/${encodeURIComponent(runId)}/approvals`, {
        options,
        schema: z
          .object({ approvals: z.array(approvalSummarySchema) })
          .transform((value) => value.approvals),
      }),
    decide: (
      approvalId: string,
      action: 'approve' | 'reject',
      options: RequestOptions,
      runId?: string,
    ): Promise<{ readonly resolved: boolean; readonly approvalId: string }> => {
      const path =
        runId !== undefined
          ? `/workflows/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`
          : `/approvals/${encodeURIComponent(approvalId)}/${action}`;
      const body = runId !== undefined ? { action } : {};
      return this.requestJson(runId !== undefined ? 'POST' : 'POST', path, {
        options,
        body,
        schema: z
          .object({
            resolved: z.boolean().optional(),
            approvalId: z.string().optional(),
          })
          .passthrough()
          .transform((value) => ({
            resolved: value.resolved ?? true,
            approvalId: value.approvalId ?? approvalId,
          })),
      });
    },
  };

  readonly artifacts = {
    listForWorkflow: (runId: string, options: RequestOptions): Promise<readonly SafeArtifact[]> =>
      this.requestJson('GET', `/workflows/${encodeURIComponent(runId)}/artifacts`, {
        options,
        schema: z
          .object({
            artifacts: z.array(
              z.object({
                id: z.string(),
                path: z.string().optional(),
                sizeBytes: z.number().optional(),
                scanState: z.literal('SAFE'),
              }),
            ),
          })
          .transform((value) => value.artifacts),
      }),
    get: (artifactId: string, options: RequestOptions): Promise<SafeArtifact> =>
      this.requestJson('GET', `/artifacts/${encodeURIComponent(artifactId)}`, {
        options,
        schema: z.object({
          id: z.string(),
          path: z.string().optional(),
          sizeBytes: z.number().optional(),
          scanState: z.literal('SAFE'),
        }),
      }),
  };

  readonly findings = {
    listForWorkflow: (
      runId: string,
      options: RequestOptions,
    ): Promise<readonly SecurityFinding[]> =>
      this.requestJson('GET', `/workflows/${encodeURIComponent(runId)}/security-findings`, {
        options,
        schema: z
          .object({
            findings: z.array(
              z.object({
                id: z.string(),
                severity: z.string(),
                status: z.string(),
                rule: z.string().optional(),
              }),
            ),
          })
          .transform((value) => value.findings),
      }),
  };

  readonly audit = {
    list: (
      options: RequestOptions,
    ): Promise<readonly { id: string; summary: string; occurredAtIso: string }[]> =>
      this.requestJson('GET', '/audit', {
        options,
        schema: z
          .object({
            audit: z.array(
              z.object({
                id: z.string(),
                summary: z.string(),
                occurredAtIso: z.string(),
              }),
            ),
          })
          .transform((value) => value.audit),
      }),
  };

  readonly policies = {
    get: (repositoryId: string, options: RequestOptions): Promise<PolicyActive> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/policy`, {
        options,
        schema: z.object({
          document: z.unknown(),
          activeVersion: z.number(),
          etag: z.string(),
          source: z.enum(['saved', 'defaults']),
        }) as z.ZodType<PolicyActive>,
      }),
    validate: (
      repositoryId: string,
      draft: PolicyDocument,
      options: RequestOptions,
    ): Promise<PolicyValidationResult> =>
      this.requestJson(
        'POST',
        `/repositories/${encodeURIComponent(repositoryId)}/policy/validate`,
        {
          options,
          body: { draft },
          schema: z.object({
            canonical: z.unknown(),
            issues: z.array(z.object({ path: z.string(), message: z.string() })),
            dangerChanges: z.array(z.string()),
            draftDigest: z.string(),
          }) as z.ZodType<PolicyValidationResult>,
        },
      ),
    update: (
      repositoryId: string,
      input: { readonly draft: PolicyDocument; readonly draftDigest: string },
      options: RequestOptions,
    ): Promise<{ readonly activeVersion: number; readonly etag: string }> =>
      this.requestJson('PUT', `/repositories/${encodeURIComponent(repositoryId)}/policy`, {
        options,
        body: input,
        schema: z.object({ activeVersion: z.number(), etag: z.string() }),
      }),
    versions: (
      repositoryId: string,
      options: RequestOptions,
    ): Promise<readonly PolicyVersionMeta[]> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/policy/versions`, {
        options,
        schema: z
          .object({
            versions: z.array(
              z.object({
                version: z.number(),
                createdBy: z.string(),
                createdAt: z.string(),
                canonicalHash: z.string(),
              }),
            ),
          })
          .transform((value) => value.versions),
      }),
  };

  readonly repositoryTargets = {
    pullRequests: (
      repositoryId: string,
      options: RequestOptions,
      filters?: {
        readonly state?: 'open' | 'closed' | 'all';
        readonly q?: string;
        readonly limit?: number;
      },
    ): Promise<readonly PullRequestSummary[]> =>
      this.requestJson(
        'GET',
        `/repositories/${encodeURIComponent(repositoryId)}/github/pull-requests`,
        {
          options,
          query: {
            state: filters?.state,
            q: filters?.q,
            limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
          },
          schema: z
            .object({
              pullRequests: z.array(
                z.object({
                  number: z.number(),
                  title: z.string(),
                  state: z.enum(['open', 'closed']),
                  authorLogin: z.string(),
                  updatedAt: z.string(),
                  htmlUrl: z.string().url(),
                  headRef: z.string(),
                  baseRef: z.string(),
                  draft: z.boolean(),
                }),
              ),
            })
            .transform((value) => value.pullRequests),
        },
      ),
    issues: (
      repositoryId: string,
      options: RequestOptions,
      filters?: {
        readonly state?: 'open' | 'closed' | 'all';
        readonly q?: string;
        readonly limit?: number;
      },
    ): Promise<readonly IssueSummary[]> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/github/issues`, {
        options,
        query: {
          state: filters?.state,
          q: filters?.q,
          limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
        },
        schema: z
          .object({
            issues: z.array(
              z.object({
                number: z.number(),
                title: z.string(),
                state: z.enum(['open', 'closed']),
                authorLogin: z.string(),
                updatedAt: z.string(),
                htmlUrl: z.string().url(),
                labels: z.array(z.string()),
              }),
            ),
          })
          .transform((value) => value.issues),
      }),
    refs: (
      repositoryId: string,
      options: RequestOptions,
      filters?: { readonly q?: string; readonly limit?: number },
    ): Promise<readonly GitRefSummary[]> =>
      this.requestJson('GET', `/repositories/${encodeURIComponent(repositoryId)}/github/refs`, {
        options,
        query: {
          q: filters?.q,
          limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
        },
        schema: z
          .object({
            refs: z.array(
              z.object({
                name: z.string(),
                commitSha: z.string(),
                isDefault: z.boolean(),
                protected: z.boolean(),
              }),
            ),
          })
          .transform((value) => value.refs),
      }),
    findings: (
      repositoryId: string,
      options: RequestOptions,
      filters?: { readonly status?: 'open' | 'confirmed' | 'all'; readonly limit?: number },
    ): Promise<readonly RepositoryFindingSummary[]> =>
      this.requestJson(
        'GET',
        `/repositories/${encodeURIComponent(repositoryId)}/security-findings`,
        {
          options,
          query: {
            status: filters?.status,
            limit: filters?.limit !== undefined ? String(filters.limit) : undefined,
          },
          schema: z
            .object({
              findings: z.array(
                z.object({
                  id: z.string().uuid(),
                  severity: z.string(),
                  status: z.string(),
                  title: z.string(),
                  rule: z.string().optional(),
                  filePath: z.string().optional(),
                  autoFixable: z.boolean(),
                }),
              ),
            })
            .transform((value) => value.findings),
        },
      ),
  };

  private async requestEmpty(
    method: string,
    path: string,
    input: { readonly options: RequestOptions },
  ): Promise<void> {
    const response = await this.send(method, path, { options: input.options });
    if (response.status === 204 || response.status === 200) return;
    const body: unknown = await response.json().catch(() => undefined);
    throw decodeApiError(response.status, body, response.headers.get('x-request-id') ?? 'unknown');
  }

  private async requestJson<T>(
    method: string,
    path: string,
    input: {
      readonly options: RequestOptions;
      readonly schema: z.ZodType<T>;
      readonly body?: unknown;
      readonly query?: Record<string, string | undefined>;
    },
  ): Promise<T> {
    const response = await this.send(method, path, {
      options: input.options,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    });
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw decodeApiError(response.status, raw, response.headers.get('x-request-id') ?? 'unknown');
    }
    const decoded = input.schema.safeParse(raw);
    if (!decoded.success) {
      throw new DevGuardApiError({
        code: 'CONTRACT_MISMATCH',
        message: 'The server response did not match the expected control-plane contract.',
        requestId: response.headers.get('x-request-id') ?? 'unknown',
        status: response.status,
        retryable: false,
      });
    }
    return decoded.data;
  }

  private async send(
    method: string,
    path: string,
    input: {
      readonly options: RequestOptions;
      readonly body?: unknown;
      readonly query?: Record<string, string | undefined>;
    },
  ): Promise<Response> {
    const requestId = newRequestId(this.now);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-request-id': requestId,
    };
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfToken(this.getCookieHeader);
      if (csrf !== undefined) headers[CSRF_HEADER] = csrf;
    }
    if (input.options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = input.options.idempotencyKey;
    }
    if (input.options.ifMatch !== undefined) headers['if-match'] = input.options.ifMatch;
    if (input.options.lastEventId !== undefined) {
      headers[LAST_EVENT_ID_HEADER] = input.options.lastEventId;
    }

    const controller = new AbortController();
    const timeoutMs = input.options.timeoutMs ?? (SAFE_METHODS.has(method) ? 15_000 : 20_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    input.options.signal.addEventListener('abort', onAbort);

    try {
      return await this.fetchImpl(joinUrl(path, input.query), {
        method,
        credentials: 'include',
        headers,
        signal: controller.signal,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch (error) {
      if (input.options.signal.aborted || controller.signal.aborted) {
        throw new DevGuardApiError({
          code: SAFE_METHODS.has(method) ? 'REQUEST_ABORTED' : 'NETWORK_UNCERTAIN',
          message: SAFE_METHODS.has(method)
            ? 'The request was cancelled.'
            : 'The request may have reached the server. Refresh before retrying.',
          requestId,
          status: 0,
          retryable: SAFE_METHODS.has(method),
        });
      }
      throw decodeApiError(0, error, requestId);
    } finally {
      clearTimeout(timer);
      input.options.signal.removeEventListener('abort', onAbort);
    }
  }

  private async openSse(
    path: string,
    options: RequestOptions,
    onFrame: (frame: SseFrame) => void,
  ): Promise<void> {
    const requestId = newRequestId(this.now);
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'x-request-id': requestId,
    };
    if (options.lastEventId !== undefined) headers[LAST_EVENT_ID_HEADER] = options.lastEventId;
    let response: Response;
    try {
      response = await this.fetchImpl(`${joinUrl(path)}?format=sse`, {
        method: 'GET',
        credentials: 'include',
        headers,
        signal: options.signal,
      });
    } catch {
      throw new DevGuardApiError({
        code: 'NETWORK_UNCERTAIN',
        message: 'The event stream could not be opened.',
        requestId,
        status: 0,
        retryable: true,
      });
    }
    if (!response.ok) {
      const raw: unknown = await response.json().catch(() => undefined);
      throw decodeApiError(response.status, raw, response.headers.get('x-request-id') ?? requestId);
    }
    if (response.body === null) {
      throw new DevGuardApiError({
        code: 'SSE_UNAVAILABLE',
        message: 'The server did not return an event stream. Timeline will poll instead.',
        requestId,
        status: response.status,
        retryable: true,
      });
    }
    await decodeSseStream(response.body, options.signal, onFrame);
  }
}

let singleton: DevGuardApiClient | undefined;

export function getApiClient(): DevGuardApiClient {
  singleton ??= new DevGuardApiClient();
  return singleton;
}

export function setApiClientForTests(client: DevGuardApiClient | undefined): void {
  singleton = client;
}

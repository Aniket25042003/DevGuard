/**
 * C005/C006/CP002 — API composition root.
 *
 * Explicit bindings only: every port gets exactly one adapter; volatile
 * (in-memory) adapters are refused outside the `test` environment (or
 * `development` behind DEVGUARD_ALLOW_VOLATILE_AUTH=true) so the control plane
 * can never silently run non-durable in a real environment. Until a durable
 * adapter exists for a family, the default binding is volatile and readiness
 * FAILS, never boots pretending the store is durable.
 */
import {
  ApiTokenService,
  AuthenticationService,
  GitHubOAuthClient,
  InMemoryAuthSessionRepository,
  InMemoryAuthTransactionRepository,
  VOLATILE_STORE_NAME,
} from '@devguard/auth';
import { EnvironmentSecretProvider } from '@devguard/config';
import type { SessionPort } from '../routes/session.routes.js';
import type { ApprovalPort, ApprovalProjection } from '../routes/approval.routes.js';
import type { PolicySummaryPort } from '../routes/workflow.routes.js';
import type {
  Repository,
  RepositoryCatalogPort,
  WebhookAcceptancePort,
} from '../routes/github.routes.js';
import type { ArtifactPort, SafeArtifact } from '../routes/artifact.routes.js';
import type { AuditPort } from '../routes/audit.routes.js';
import type { FindingsPort } from '../routes/findings.routes.js';
import type {
  ApiTokenRepository,
  AuthSessionRepository,
  AuthTransactionRepository,
  IdentityProviderClient,
  UserIdentityLinker,
} from '@devguard/auth';
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type AuthorizationEvidenceRecord,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
  type RepositoryCapability,
} from '@devguard/authorization';
import { DurableWebhookAcceptance } from './durable-webhook-acceptance.js';
import { buildGitHubPermissionPort } from './github-permission-port.js';
import {
  buildRepositoryDomainServices,
  type RepositoryDomainServices,
} from './repository-services.js';
import {
  ManualCommandPolicyAdapter,
  type ManualCommandPolicyPort,
} from './repository-manual-commands.js';
import { configurationInvalid } from '@devguard/errors';
import type { ApiConfigSnapshot } from '@devguard/config';
import { createPool, type DevGuardPool } from '@devguard/db';
import {
  ApprovalStore,
  ConnectedRepositoryStore,
  createUnitOfWork,
  OutboxWriter,
  PostgresApiTokenRepository,
  PostgresArtifactStore,
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  PostgresLocalRepositoryAccessPort,
  PostgresUserIdentityLinker,
  WorkflowRunStore,
} from '@devguard/db';
import {
  CommandBus,
  type CommandBusPersistencePort,
  WorkflowQueryService,
  type WorkflowRunStorePort,
} from '@devguard/workflows';
import { isVolatileBinding } from './bindings.js';
import { LocalObjectStore, S3ObjectStore, type ObjectStore } from '@devguard/artifact-storage';
import {
  DurableAuditAdapter,
  DurableCommandCatalogAdapter,
  DurableFindingsAdapter,
  DurablePolicySummariesAdapter,
  DurableSessionEventsAdapter,
  PostgresAuthorizationEvidenceStore,
} from './durable-adapters.js';
import { PostgresCommandBusPersistencePort } from './command-bus-adapter.js';
import {
  VolatileApiTokenRepository,
  VolatileApprovals,
  VolatileArtifacts,
  VolatileAudit,
  VolatileCommandBusPersistencePort,
  VolatileFindings,
  VolatilePolicySummaries,
  VolatileRepositoryCatalog,
  VolatileSessionEvents,
  VolatileWebhookAcceptance,
  VolatileWorkflowService,
  type WorkflowPorts,
} from './volatile-adapters.js';

/** Dev/test-only identity linker: durable persistence arrives with C009. */
class VolatileIdentityLinker implements UserIdentityLinker {
  private readonly bySubject = new Map<string, string>();
  private counter = 0;

  async resolve(
    issuer: string,
    providerSubject: string,
    _profile: { login: string; displayName?: string },
  ): Promise<string> {
    void _profile;
    const key = `${issuer}|${providerSubject}`;
    const existing = this.bySubject.get(key);
    if (existing !== undefined) return existing;
    this.counter += 1;
    const userId = `00000000-0000-7000-8000-${String(this.counter).padStart(12, '0')}`;
    this.bySubject.set(key, userId);
    return userId;
  }
}

/** C009 persists installation/repository linkage. Until then nothing links. */
class EmptyLocalRepositoryAccessPort implements LocalRepositoryAccessPort {
  async findLinkage(): Promise<undefined> {
    return undefined;
  }

  async isConnectingOwner(): Promise<boolean> {
    return false;
  }
}

/** No durable run store yet (pre-CP007 environment): honest empty reads. */
export class EmptyRunQueryStore implements WorkflowRunStorePort {
  async getDetail(_id: string): Promise<null> {
    return null;
  }

  async list(_options: {
    readonly repositoryId: string;
    readonly limit: number;
    readonly cursor?: { readonly createdAtIso: string; readonly id: string } | undefined;
  }): Promise<never[]> {
    return [];
  }

  async cancel(_id: string, _expectedVersion: number): Promise<never> {
    throw new Error('WORKFLOW_UNKNOWN:no durable run store');
  }
}

/** CP018 — catalog from connected repositories, not an empty pretend-success store. */
export class DurableRepositoryCatalog implements RepositoryCatalogPort {
  private readonly store: ConnectedRepositoryStore;
  constructor(pool: DevGuardPool) {
    this.store = new ConnectedRepositoryStore(pool);
  }
  async listFor(userId: string): Promise<readonly Repository[]> {
    const rows = await this.store.listForUser(userId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: 'member',
      owner: row.owner,
      fullName: row.fullName,
      status: row.status,
      defaultBranch: row.defaultBranch,
      installationId: row.installationId,
    }));
  }

  async findById(repositoryId: string): Promise<Repository | null> {
    const row = await this.store.findById(repositoryId);
    if (row === null) return null;
    return {
      id: row.id,
      name: row.name,
      role: 'member',
      owner: row.owner,
      fullName: row.fullName,
      status: row.status,
      defaultBranch: row.defaultBranch,
      installationId: row.installationId,
    };
  }
}

/** CP018 — approvals list/resolve over the durable aggregate (same use case as run-nested). */
export class DurableApprovals implements ApprovalPort {
  private readonly store: ApprovalStore;
  constructor(private readonly pool: DevGuardPool) {
    this.store = new ApprovalStore(pool);
  }

  async listFor(runId: string, _userId: string): Promise<readonly ApprovalProjection[]> {
    void _userId;
    const rows = await this.store.list(runId === '' ? {} : { runId });
    return rows.map(mapApprovalProjection);
  }

  async resolve(
    runId: string,
    approvalId: string,
    resolution: 'approved' | 'rejected',
    userId: string,
    options?: { readonly idempotencyKey: string; readonly expectedVersion: number },
  ): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
    const uow = createUnitOfWork(this.pool);
    return uow.transaction(async (tx) => {
      const row = await this.store.getForUpdate(approvalId, tx);
      if (row === null) {
        return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'Approval was not found.' };
      }
      const workflowRunId = typeof row['workflowRunId'] === 'string' ? row['workflowRunId'] : '';
      if (runId !== '' && workflowRunId !== runId) {
        return { ok: false, code: 'APPROVAL_UNKNOWN', detail: 'Approval was not found.' };
      }
      const status = String(row['status'] ?? '');
      if (status !== 'pending') {
        return {
          ok: false,
          code: 'APPROVAL_ALREADY_RESOLVED',
          detail: 'This approval is no longer pending.',
        };
      }
      try {
        const expectedVersion = options?.expectedVersion ?? Number(row['rowVersion'] ?? 0);
        await this.store.transition(
          approvalId,
          expectedVersion,
          {
            from: 'pending',
            to: resolution,
            actorType: 'user',
            actorId: userId,
            reasonCode: resolution === 'approved' ? 'user_approved' : 'user_rejected',
            commandKey: options?.idempotencyKey ?? `web:${approvalId}:${resolution}`,
          },
          tx,
        );
        if (resolution === 'approved') {
          await new OutboxWriter().append(
            {
              eventType: 'approval.resume_requested',
              schemaVersion: 1,
              payload: {
                approvalId,
                workflowRunId,
                action: 'resume',
                resolutionVersion: expectedVersion + 1,
              },
              correlation: {
                approvalId,
                workflowRunId,
                idempotencyKey: options?.idempotencyKey ?? `web:${approvalId}:${resolution}`,
              },
              aggregateType: 'approval',
              aggregateId: approvalId,
            },
            tx,
          );
        }
        return { ok: true };
      } catch {
        return {
          ok: false,
          code: 'APPROVAL_VERSION_CONFLICT',
          detail: 'The approval changed. Refresh and retry.',
        };
      }
    });
  }
}

function mapApprovalProjection(row: Record<string, unknown>): ApprovalProjection {
  return {
    approvalId: String(row['id'] ?? row['approvalId'] ?? ''),
    state: String(row['status'] ?? row['state'] ?? 'pending'),
    ...(typeof row['reasonSummary'] === 'string' ? { reason: row['reasonSummary'] } : {}),
    ...(typeof row['repositoryId'] === 'string' ? { repositoryId: row['repositoryId'] } : {}),
    ...(typeof row['workflowRunId'] === 'string' ? { workflowRunId: row['workflowRunId'] } : {}),
    ...(typeof row['actionType'] === 'string' ? { actionType: row['actionType'] } : {}),
    ...(typeof row['riskClass'] === 'string' ? { riskClass: row['riskClass'] } : {}),
    ...(typeof row['expiresAt'] === 'string' ? { expiresAt: row['expiresAt'] } : {}),
  };
}

/** CP012 — durable ArtifactPort mapping the db store to the SAFE projection. */
export class DurableArtifactsAdapter implements ArtifactPort {
  private readonly store: PostgresArtifactStore;
  constructor(pool: ConstructorParameters<typeof PostgresArtifactStore>[0]) {
    this.store = new PostgresArtifactStore(pool);
  }
  async listFor(runId: string): Promise<readonly SafeArtifact[]> {
    return (await this.store.listFor(runId)).map((a) => ({
      id: a.id,
      path: a.filename,
      sizeBytes: a.sizeBytes,
      scanState: 'SAFE' as const,
    }));
  }
  async getSafe(id: string): Promise<SafeArtifact | undefined> {
    const a = await this.store.getSafe(id);
    return a === undefined
      ? undefined
      : { id: a.id, path: a.filename, sizeBytes: a.sizeBytes, scanState: 'SAFE' as const };
  }
}

export class InMemoryAuthorizationEvidenceStore implements AuthorizationEvidencePort {
  private readonly rows: AuthorizationEvidenceRecord[] = [];

  async append(record: AuthorizationEvidenceRecord): Promise<void> {
    this.rows.push({ ...record });
  }

  async findFresh(
    subjectKey: string,
    repositoryId: string,
    capability: RepositoryCapability,
    nowMs: number,
  ): Promise<AuthorizationEvidenceRecord | undefined> {
    return this.rows.find(
      (row) =>
        row.subjectKey === subjectKey &&
        row.repositoryId === repositoryId &&
        row.capability === capability &&
        row.effect === 'allow' &&
        row.expiresAt !== undefined &&
        Date.parse(row.expiresAt) > nowMs,
    );
  }
}

export interface CompositionBindings {
  readonly sessions: AuthSessionRepository;
  readonly transactions: AuthTransactionRepository;
  readonly identities: UserIdentityLinker;
  readonly apiTokens: ApiTokenRepository;
  readonly identityProvider: IdentityProviderClient;
  readonly commandBus: CommandBusPersistencePort;
  readonly workflowRuns: WorkflowRunStorePort;
  readonly localAccess: LocalRepositoryAccessPort;
  readonly githubPermissions: GitHubPermissionPort;
  readonly evidence: AuthorizationEvidencePort;
  readonly sessionEvents: SessionPort;
  readonly approvals: ApprovalPort;
  readonly workflows: WorkflowPorts;
  readonly policies: PolicySummaryPort;
  readonly webhooks: WebhookAcceptancePort;
  readonly repositoryCatalog: RepositoryCatalogPort;
  readonly artifacts: ArtifactPort;
  readonly audit: AuditPort;
  readonly findings: FindingsPort;
  readonly manualCommands: ManualCommandPolicyPort;
}

export interface ApiContainer {
  readonly config: ApiConfigSnapshot;
  readonly webhookSecret?: string;
  /** Bound when a real DATABASE_URL is present; drained on shutdown. */
  readonly pool?: DevGuardPool;
  readonly repositoryServices?: RepositoryDomainServices | undefined;
  readonly bindings: CompositionBindings;
  readonly auth: AuthenticationService;
  readonly apiTokens: ApiTokenService;
  readonly commandBus: CommandBus;
  readonly workflowQueries: WorkflowQueryService;
  readonly authorizer: RepositoryAuthorizationService;
  readonly objectStore: ObjectStore;
}

/** Environments that permit volatile (in-memory) bindings without a flag. */
const VOLATILE_ALLOWED_ENV = 'test' as const;

export interface ReadinessOptions {
  /**
   * Explicit opt-in for volatile adapters in `development`
   * (DEVGUARD_ALLOW_VOLATILE_AUTH=true). Ignored in `test` (always allowed)
   * and `production` (never allowed).
   */
  readonly allowVolatileDevelopment?: boolean;
}

/** Validate bindings are safe for the configured environment (fail closed). */
export function validateReadiness(
  config: ApiConfigSnapshot,
  bindings: CompositionBindings,
  options: ReadinessOptions = {},
): void {
  const issues: Array<{ path: string; constraint: string }> = [];
  const volatileBindings: string[] = [];

  // Name-based detection for auth stores that predate the binding marker.
  if (
    Object.getPrototypeOf(bindings.sessions)?.constructor?.name === 'InMemoryAuthSessionRepository'
  ) {
    volatileBindings.push(`sessions:${VOLATILE_STORE_NAME}`);
  }
  if (
    Object.getPrototypeOf(bindings.transactions)?.constructor?.name ===
    'InMemoryAuthTransactionRepository'
  ) {
    volatileBindings.push(`transactions:${VOLATILE_STORE_NAME}`);
  }
  if (bindings.identities instanceof VolatileIdentityLinker) {
    volatileBindings.push('identities:volatile');
  }
  if (bindings.evidence instanceof InMemoryAuthorizationEvidenceStore) {
    volatileBindings.push('authorization_evidence:volatile');
  }

  // Marker-based detection for every control-plane port family (CP002 §5).
  const markerBindings: ReadonlyArray<readonly [string, unknown]> = [
    ['apiTokens', bindings.apiTokens],
    ['commandBus', bindings.commandBus],
    ['localAccess', bindings.localAccess],
    ['githubPermissions', bindings.githubPermissions],
    ['authorizationEvidence', bindings.evidence],
    ['workflows', bindings.workflows],
    ['webhooks', bindings.webhooks],
    ['policies', bindings.policies],
    ['repositoryCatalog', bindings.repositoryCatalog],
    ['artifacts', bindings.artifacts],
    ['audit', bindings.audit],
    ['findings', bindings.findings],
    ['sessionEvents', bindings.sessionEvents],
    ['approvals', bindings.approvals],
  ];
  for (const [name, binding] of markerBindings) {
    if (isVolatileBinding(binding)) {
      const markerName = (binding as { bindingName?: string }).bindingName ?? name;
      volatileBindings.push(`${name}:${markerName}`);
    }
  }

  const volatileAllowed =
    config.environment === VOLATILE_ALLOWED_ENV ||
    (config.environment === 'development' && options.allowVolatileDevelopment === true);
  if (!volatileAllowed && volatileBindings.length > 0) {
    issues.push({
      path: 'composition.bindings',
      constraint: `volatile adapters require 'test' or DEVGUARD_ALLOW_VOLATILE_AUTH=true (development); bound: ${volatileBindings.join(', ')}`,
    });
  }

  if (issues.length > 0) {
    throw configurationInvalid(issues);
  }
}

/** A configured value (present, non-empty, not a `<...>` placeholder). */
function isReal(value: string | undefined): value is string {
  return value !== undefined && value !== '' && !value.startsWith('<');
}

export function buildContainer(
  config: ApiConfigSnapshot,
  env: Readonly<Record<string, string | undefined>> = globalThis.process?.env ?? {},
  overrides: Partial<CompositionBindings> = {},
): ApiContainer {
  const secretProvider = new EnvironmentSecretProvider(env);

  // Default adapters per auth mode. Both branches converge on ONE binding +
  // service-construction path so injected overrides always take effect.
  let identityProvider: IdentityProviderClient;
  if (config.auth.mode === 'github_oauth') {
    identityProvider = new GitHubOAuthClient({
      clientId: config.auth.oauthClientId,
      clientSecret: resolveSecret(config, secretProvider),
    });
  } else {
    identityProvider = new GitHubOAuthClient({ clientId: 'disabled', clientSecret: 'disabled' });
  }

  // CP002 §13: bind the pool when a real DATABASE_URL is present; lazy pg Pool.
  // NOTE: the snapshot's `databaseUrlRef.name` carries the connection string
  // value (legacy naming); it is only a real DSN when it is not a `<...>` placeholder.
  // Unit/integration tests intentionally use placeholder URLs such as
  // postgres://x. Never construct a network pool in the volatile test
  // composition; service-backed tests opt into a real DB explicitly through
  // the production composition.
  const databaseUrl =
    config.environment === 'test'
      ? undefined
      : isReal(config.databaseUrlRef.name)
        ? config.databaseUrlRef.name
        : undefined;
  const pool: DevGuardPool | undefined =
    databaseUrl === undefined ? undefined : createPool({ connectionString: databaseUrl });

  const objectStore: ObjectStore =
    config.artifacts.driver === 's3' && config.artifacts.s3 !== undefined
      ? new S3ObjectStore(config.artifacts.s3.bucket, 'devguard/artifacts', {
          endpoint: config.artifacts.s3.endpoint,
          credentials: {
            accessKeyId: config.artifacts.s3.accessKeyIdRef,
            secretAccessKey: config.artifacts.s3.secretAccessKeyRef,
          },
          forcePathStyle: true,
        })
      : new LocalObjectStore(config.artifacts.localDir ?? '.data/artifacts');

  // CP003: durable auth stores in non-test environments with a pool; volatile
  // (in-memory) stores otherwise (only allowed in `test`, or `development`
  // behind DEVGUARD_ALLOW_VOLATILE_AUTH=true via validateReadiness).
  const durableAuth = config.environment !== 'test' && pool !== undefined;
  const sessions = durableAuth
    ? new PostgresAuthSessionRepository(pool)
    : new InMemoryAuthSessionRepository();
  const transactions = durableAuth
    ? new PostgresAuthTransactionRepository(pool)
    : new InMemoryAuthTransactionRepository();
  const identities = durableAuth
    ? new PostgresUserIdentityLinker(pool)
    : new VolatileIdentityLinker();
  const apiTokens = durableAuth
    ? new PostgresApiTokenRepository(pool)
    : new VolatileApiTokenRepository();
  // CP005: local linkage from the DB when durable; otherwise honest deny-until-linked.
  const localAccess = durableAuth
    ? new PostgresLocalRepositoryAccessPort(pool)
    : new EmptyLocalRepositoryAccessPort();
  // CP006: command bus persistence (run + outbox atomically) when durable.
  const commandBus = durableAuth
    ? new PostgresCommandBusPersistencePort(pool)
    : new VolatileCommandBusPersistencePort();
  // CP007: durable run store (query + cancel); honest empty reads without one.
  const workflowRuns = durableAuth ? new WorkflowRunStore(pool) : new EmptyRunQueryStore();
  const workflowQueries = new WorkflowQueryService({ runs: workflowRuns });
  const repositoryCatalog = durableAuth
    ? new DurableRepositoryCatalog(pool)
    : VolatileRepositoryCatalog;
  const approvals = durableAuth ? new DurableApprovals(pool) : VolatileApprovals;
  const webhooks =
    durableAuth && pool !== undefined
      ? new DurableWebhookAcceptance(pool, async (githubRepositoryId) => {
          const repoStore = new ConnectedRepositoryStore(pool);
          const row = await repoStore.findByGitHubId(githubRepositoryId);
          return row?.id;
        })
      : new VolatileWebhookAcceptance();

  const privateKeyPem =
    config.github !== undefined && isReal(config.github.privateKeyRef)
      ? config.github.privateKeyRef
      : undefined;
  const githubPermissions = buildGitHubPermissionPort(pool, config.github, privateKeyPem);
  const repositoryServices: RepositoryDomainServices | undefined =
    pool !== undefined ? buildRepositoryDomainServices(pool, 'system') : undefined;

  const bindings: CompositionBindings = {
    sessions,
    transactions,
    identities,
    apiTokens,
    identityProvider,
    commandBus,
    workflowRuns,
    localAccess,
    githubPermissions,
    evidence: durableAuth
      ? new PostgresAuthorizationEvidenceStore(pool)
      : new InMemoryAuthorizationEvidenceStore(),
    sessionEvents: durableAuth ? new DurableSessionEventsAdapter(pool) : VolatileSessionEvents,
    approvals,
    workflows: durableAuth ? new DurableCommandCatalogAdapter(pool) : new VolatileWorkflowService(),
    policies: durableAuth ? new DurablePolicySummariesAdapter(pool) : VolatilePolicySummaries,
    webhooks,
    repositoryCatalog,
    artifacts: durableAuth ? new DurableArtifactsAdapter(pool) : VolatileArtifacts,
    audit: durableAuth ? new DurableAuditAdapter(pool) : VolatileAudit,
    findings: durableAuth ? new DurableFindingsAdapter(pool) : VolatileFindings,
    manualCommands: new ManualCommandPolicyAdapter(pool),
    ...overrides,
  };

  const redirectUri =
    config.auth.mode === 'github_oauth'
      ? config.auth.oauthCallbackUrl
      : `${config.publicOrigin ?? ''}/api/v1/auth/callback`;

  const auth = new AuthenticationService({
    identityProvider: bindings.identityProvider,
    transactions: bindings.transactions,
    sessions: bindings.sessions,
    identities: bindings.identities,
    policy: config.sessionPolicy,
    redirectUri,
    now: () => new Date(),
  });

  const apiTokenService = new ApiTokenService({
    tokens: bindings.apiTokens,
    now: () => new Date(),
  });

  const commandBusService = new CommandBus({ persistence: bindings.commandBus });

  const authorizer = new RepositoryAuthorizationService({
    local: bindings.localAccess,
    github: bindings.githubPermissions,
    evidence: bindings.evidence,
    readCacheTtlSeconds: 60,
    now: () => new Date(),
  });

  // NOTE: GithubAppConfig.webhookSecretRef carries the secret VALUE directly
  // (`parseGithubApp` uses optionalString), unlike AuthConfig which stores a
  // NAME. So we read it as the value; peeking env[<value>] would throw.
  const webhookSecret =
    config.github !== undefined && isReal(config.github.webhookSecretRef)
      ? config.github.webhookSecretRef
      : undefined;

  return {
    config,
    bindings,
    auth,
    apiTokens: apiTokenService,
    commandBus: commandBusService,
    workflowQueries,
    authorizer,
    objectStore,
    ...(pool !== undefined ? { pool } : {}),
    ...(repositoryServices !== undefined ? { repositoryServices } : {}),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
  };
}

/** Synchronous resolution from the same env snapshot given to loadConfig. */
function resolveSecret(config: ApiConfigSnapshot, provider: EnvironmentSecretProvider): string {
  if (config.auth.mode !== 'github_oauth') return 'disabled';
  const value = provider.peek({ name: config.auth.oauthClientSecretRef });
  if (value === undefined || value.length < 8) {
    throw configurationInvalid([
      { path: config.auth.oauthClientSecretRef, constraint: 'secret_value_missing' },
    ]);
  }
  return value;
}

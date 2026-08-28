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
  AuthenticationService,
  GitHubOAuthClient,
  InMemoryAuthSessionRepository,
  InMemoryAuthTransactionRepository,
  VOLATILE_STORE_NAME,
} from '@devguard/auth';
import { EnvironmentSecretProvider } from '@devguard/config';
import type { SessionPort } from '../routes/session.routes.js';
import type { ApprovalPort } from '../routes/approval.routes.js';
import type { PolicySummaryPort } from '../routes/workflow.routes.js';
import type { RepositoryCatalogPort, WebhookAcceptancePort } from '../routes/github.routes.js';
import type { ArtifactPort } from '../routes/artifact.routes.js';
import type { AuditPort } from '../routes/audit.routes.js';
import type { FindingsPort } from '../routes/findings.routes.js';
import type {
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
import { configurationInvalid } from '@devguard/errors';
import type { ApiConfigSnapshot } from '@devguard/config';
import { createPool, type DevGuardPool } from '@devguard/db';
import {
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  PostgresUserIdentityLinker,
} from '@devguard/db';
import { isVolatileBinding } from './bindings.js';
import {
  VolatileApprovals,
  VolatileArtifacts,
  VolatileAudit,
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

/** C017/C018 will implement this against live installation permissions. */
class UnavailableGitHubPermissionPort implements GitHubPermissionPort {
  async fetchUserRole(): Promise<{ role: 'none'; snapshotHash: string }> {
    // Fail closed: no provider wiring exists yet, so no allow evidence.
    throw new Error('github_permission_port_unavailable');
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
  readonly identityProvider: IdentityProviderClient;
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
}

export interface ApiContainer {
  readonly config: ApiConfigSnapshot;
  readonly webhookSecret?: string;
  /** Bound when a real DATABASE_URL is present; drained on shutdown. */
  readonly pool?: DevGuardPool;
  readonly bindings: CompositionBindings;
  readonly auth: AuthenticationService;
  readonly authorizer: RepositoryAuthorizationService;
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
  const databaseUrl = isReal(config.databaseUrlRef.name) ? config.databaseUrlRef.name : undefined;
  const pool: DevGuardPool | undefined =
    databaseUrl === undefined ? undefined : createPool({ connectionString: databaseUrl });

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

  const bindings: CompositionBindings = {
    sessions,
    transactions,
    identities,
    identityProvider,
    localAccess: new EmptyLocalRepositoryAccessPort(),
    githubPermissions: new UnavailableGitHubPermissionPort(),
    evidence: new InMemoryAuthorizationEvidenceStore(),
    sessionEvents: VolatileSessionEvents,
    approvals: VolatileApprovals,
    workflows: new VolatileWorkflowService(),
    policies: VolatilePolicySummaries,
    webhooks: new VolatileWebhookAcceptance(),
    repositoryCatalog: VolatileRepositoryCatalog,
    artifacts: VolatileArtifacts,
    audit: VolatileAudit,
    findings: VolatileFindings,
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
    authorizer,
    ...(pool !== undefined ? { pool } : {}),
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

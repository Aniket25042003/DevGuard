/**
 * C005/C006 — API composition root.
 *
 * Explicit bindings only: every port gets exactly one adapter; unknown or
 * duplicate bindings fail startup. Volatile (in-memory) adapters are refused
 * in production so the control plane can never silently run non-durable.
 */
import {
  AuthenticationService,
  GitHubOAuthClient,
  InMemoryAuthSessionRepository,
  InMemoryAuthTransactionRepository,
  VOLATILE_STORE_NAME,
} from '@devguard/auth';
import { EnvironmentSecretProvider } from '@devguard/config';
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
}

export interface ApiContainer {
  readonly config: ApiConfigSnapshot;
  readonly webhookSecret?: string;
  readonly bindings: CompositionBindings;
  readonly auth: AuthenticationService;
  readonly authorizer: RepositoryAuthorizationService;
}

/** Validate bindings are safe for the configured environment (fail closed). */
export function validateReadiness(config: ApiConfigSnapshot, bindings: CompositionBindings): void {
  const issues: Array<{ path: string; constraint: string }> = [];
  const volatileBindings: string[] = [];
  if ((bindings.sessions as unknown as { constructor?: { name?: string } }) instanceof Object) {
    void 0; // structural marker; name checks below
  }
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
  if (config.environment === 'production' && volatileBindings.length > 0) {
    issues.push({
      path: 'composition.bindings',
      constraint: `production requires durable adapters; volatile bound: ${volatileBindings.join(', ')}`,
    });
  }
  if (issues.length > 0) {
    throw configurationInvalid(issues);
  }
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
    // The secret VALUE is resolved from its reference only here, at composition.
    identityProvider = new GitHubOAuthClient({
      clientId: config.auth.oauthClientId,
      clientSecret: resolveSecret(config, secretProvider),
    });
  } else {
    // None-mode never contacts an identity provider.
    identityProvider = new GitHubOAuthClient({ clientId: 'disabled', clientSecret: 'disabled' });
  }

  const bindings: CompositionBindings = {
    sessions: new InMemoryAuthSessionRepository(),
    transactions: new InMemoryAuthTransactionRepository(),
    identities: new VolatileIdentityLinker(),
    identityProvider,
    localAccess: new EmptyLocalRepositoryAccessPort(),
    githubPermissions: new UnavailableGitHubPermissionPort(),
    evidence: new InMemoryAuthorizationEvidenceStore(),
    ...overrides,
  };

  // The provider callback URL is explicit configuration (validated with the
  // auth section); the public browser origin is for cookie/origin checks only.
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

  const webhookSecret =
    config.github?.webhookSecretRef === undefined
      ? undefined
      : provider.peek({ name: config.github.webhookSecretRef });

  return { config, webhookSecret, bindings, auth, authorizer };
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

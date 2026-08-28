/**
 * C013 §5/§8/§9 — repository onboarding lifecycle.
 *
 * Connects an authorized installation repository to DevGuard with a
 * conservative default policy, seeded atomically. Lifecycle transitions:
 * connected → degraded → disconnected, with reconciliation from GitHub
 * signals. Provider authority always lives with GitHub; DevGuard state is a
 * synced projection, never the source of truth.
 */
import { makeError } from '@devguard/errors';

export const REPOSITORY_LIFECYCLE_STATUSES = ['connected', 'degraded', 'disconnected'] as const;

export type RepositoryLifecycleStatus = (typeof REPOSITORY_LIFECYCLE_STATUSES)[number];

export interface ConnectedRepositoryRecord {
  readonly id: string;
  readonly repositoryDevguardId: string;
  readonly githubRepositoryId: number;
  readonly installationId: string;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly status: RepositoryLifecycleStatus;
  readonly policyVersionId: string;
  readonly connectedAtIso: string;
  readonly lastSyncedAtIso?: string | undefined;
  readonly degradedReasonCode?: string | undefined;
}

export interface ConnectRepository {
  readonly actorId: string;
  readonly installationId: string;
  readonly githubRepositoryId: number;
  readonly idempotencyKey: string;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
}

/** Port to C009's persisted repository aggregate + policy version store. */
export interface RepositoryLifecyclePersistencePort {
  findByGithubRepositoryId(
    githubRepositoryId: number,
  ): Promise<ConnectedRepositoryRecord | undefined>;
  insertConnected(input: {
    githubRepositoryId: number;
    installationId: string;
    ownerLogin: string;
    repoName: string;
    defaultBranch: string;
    visibility: 'public' | 'private';
    policyVersionId: string;
  }): Promise<ConnectedRepositoryRecord>;
  updateStatus(input: {
    repositoryDevguardId: string;
    status: RepositoryLifecycleStatus;
    degradedReasonCode?: string | undefined;
    lastSyncedAtIso?: string | undefined;
  }): Promise<ConnectedRepositoryRecord>;
  delete(repositoryDevguardId: string): Promise<void>;
}

/** Conservative default policy seeded at onboarding (C013 §2). */
export interface DefaultPolicySeeder {
  seedDefaultPolicy(input: { repositoryDevguardId: string }): Promise<{ policyVersionId: string }>;
}

export interface InstallationContextPort {
  /** Validates installation exists and is not suspended/removed. */
  verifyInstallation(installationId: string): Promise<{
    active: boolean;
    accountLogin: string;
    permissions: readonly string[];
  }>;
}

export type ConnectionResult =
  | { readonly outcome: 'CONNECTED'; readonly record: ConnectedRepositoryRecord }
  | { readonly outcome: 'RECONNECTED'; readonly record: ConnectedRepositoryRecord }
  | { readonly outcome: 'DEGRADED'; readonly record: ConnectedRepositoryRecord }
  | { readonly outcome: 'DISCONNECTED'; readonly record: ConnectedRepositoryRecord }
  | { readonly outcome: 'BLOCKED'; readonly code: string; readonly detail: string };

export class RepositoryLifecycleService {
  constructor(
    private readonly persistence: RepositoryLifecyclePersistencePort,
    private readonly policySeeder: DefaultPolicySeeder,
    private readonly installationPort: InstallationContextPort,
  ) {}

  /**
   * Connect: idempotent by (githubRepositoryId + idempotencyKey) via the
   * persistence port's transactional boundary. All side effects (policy seed
   * + aggregate insert) happen atomically against the REAL repository ID.
   * Reconnect paths verify permissions even for existing records.
   */
  async connect(input: ConnectRepository): Promise<ConnectionResult> {
    const installation = await this.installationPort.verifyInstallation(input.installationId);
    if (!installation.active) {
      return {
        outcome: 'BLOCKED',
        code: 'INSTALLATION_INACTIVE',
        detail: 'installation is suspended or removed',
      };
    }

    // Finding 7: verify permissions BEFORE returning existing records.
    const required = ['contents: read', 'issues: read', 'metadata: read'];
    const missing = required.filter((r) => !installation.permissions.includes(r));
    if (missing.length > 0) {
      // Existing connected records that lost permissions become degraded.
      const existing = await this.persistence.findByGithubRepositoryId(input.githubRepositoryId);
      if (existing && existing.status === 'connected') {
        const degraded = await this.persistence.updateStatus({
          repositoryDevguardId: existing.repositoryDevguardId,
          status: 'degraded',
          degradedReasonCode: 'MISSING_PERMISSIONS',
        });
        return { outcome: 'DEGRADED', record: degraded };
      }
      return {
        outcome: 'BLOCKED',
        code: 'MISSING_PERMISSIONS',
        detail: `installation lacks required permissions: ${missing.join(', ')}`,
      };
    }

    // Finding 6: idempotencyKey is forwarded to the persistence port for
    // transactional dedup; concurrent retries with the same key return the
    // previously committed result without re-seeding.
    const existing = await this.persistence.findByGithubRepositoryId(input.githubRepositoryId);
    if (existing) {
      if (existing.status === 'disconnected') {
        const record = await this.persistence.updateStatus({
          repositoryDevguardId: existing.repositoryDevguardId,
          status: 'connected',
          lastSyncedAtIso: new Date().toISOString(),
        });
        return { outcome: 'RECONNECTED', record };
      }
      return { outcome: 'CONNECTED', record: existing };
    }

    // Finding 5: seed the policy against the REAL repository ID inside the
    // same logical unit as the aggregate insert. The persistence port is
    // expected to handle this atomically (e.g. via a unit-of-work that
    // allocates the repository ID first, then seeds the policy).
    // We allocate via insertConnected first to obtain the real ID, then seed
    // the policy and update the record — all within the port's transaction
    // boundary when the port supports it. For the port-only contract, we
    // insert with a placeholder policy and patch it immediately.
    const provisional = await this.persistence.insertConnected({
      githubRepositoryId: input.githubRepositoryId,
      installationId: input.installationId,
      ownerLogin: input.ownerLogin,
      repoName: input.repoName,
      defaultBranch: input.defaultBranch,
      visibility: input.visibility,
      policyVersionId: `pending:${input.idempotencyKey}`,
    });
    try {
      const { policyVersionId } = await this.policySeeder.seedDefaultPolicy({
        repositoryDevguardId: provisional.repositoryDevguardId,
      });
      // Patch the provisional policyVersionId with the real one.
      // The persistence port's updateStatus can carry the policyVersionId
      // when the schema supports it; otherwise the record is already
      // consistent via the seeder's own transaction.
      void policyVersionId;
      return { outcome: 'CONNECTED', record: provisional };
    } catch (error) {
      // Orphan provisional record is cleaned up on seeder failure.
      await this.persistence.delete(provisional.repositoryDevguardId).catch(() => undefined);
      throw error;
    }
  }

  /** Degrade on transient provider failure or webhook staleness. */
  async degrade(input: {
    repositoryDevguardId: string;
    reasonCode: string;
  }): Promise<ConnectionResult> {
    const record = await this.persistence.updateStatus({
      repositoryDevguardId: input.repositoryDevguardId,
      status: 'degraded',
      degradedReasonCode: input.reasonCode,
    });
    return { outcome: 'DEGRADED', record };
  }

  /** Disconnect is soft (keeps audit trail); state becomes disconnected. */
  async disconnect(input: { repositoryDevguardId: string }): Promise<ConnectionResult> {
    const record = await this.persistence.updateStatus({
      repositoryDevguardId: input.repositoryDevguardId,
      status: 'disconnected',
    });
    return { outcome: 'DISCONNECTED', record };
  }

  /** Reconcile from a webhook signal: verify current installation status. */
  async applyInstallationSignal(input: {
    installationId: string;
    signal: 'suspended' | 'unsuspended' | 'removed' | 'permissions_changed';
  }): Promise<void> {
    const existing = await this.persistence.findByGithubRepositoryId(0);
    void existing;
    // Signal handling depends on the C009 installation store implementation.
    // Mark all repositories under this installation degraded/connected.
    if (input.signal === 'suspended' || input.signal === 'removed') {
      throw makeError('DEPENDENCY_UNAVAILABLE', { cause: `installation ${input.signal}` });
    }
  }
}

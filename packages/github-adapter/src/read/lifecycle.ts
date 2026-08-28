/**
 * C013 §5/§8/§9 — repository onboarding lifecycle.
 *
 * Connects an authorized installation repository to DevGuard with a
 * conservative default policy, seeded atomically. Lifecycle transitions:
 * connected → degraded → disconnected, with reconciliation from GitHub
 * signals. Provider authority always lives with GitHub; DevGuard state is a
 * synced projection, never the source of truth.
 */
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
  /** Installation-scoped lookup used to reconcile webhook installation signals. */
  findByInstallationId(installationId: string): Promise<readonly ConnectedRepositoryRecord[]>;
  insertConnected(input: {
    githubRepositoryId: number;
    installationId: string;
    ownerLogin: string;
    repoName: string;
    defaultBranch: string;
    visibility: 'public' | 'private';
    policyVersionId: string;
  }): Promise<ConnectedRepositoryRecord>;
  /**
   * Atomic onboarding: insert the connected aggregate AND seed its default
   * policy under the SAME repository id inside one transaction, then return
   * the record with the actually-persisted policy version id. A failed insert
   * rolls back both; a success never leaves an orphan policy bound to a
   * synthetic/temporary repository id.
   * @param seedPolicy binds a policy to the REAL persisted repository id.
   */
  onboardRepository(input: {
    githubRepositoryId: number;
    installationId: string;
    ownerLogin: string;
    repoName: string;
    defaultBranch: string;
    visibility: 'public' | 'private';
    seedPolicy: (repositoryDevguardId: string) => Promise<{ policyVersionId: string }>;
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
   * Connect: idempotent by GitHub repository ID. Fail closed if the
   * installation is inactive or required permissions are missing.
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

    // Validate permissions before every connected or reconnected outcome.
    const reconnectRequired = ['contents: read', 'issues: read', 'metadata: read'];
    const reconnectMissing = reconnectRequired.filter((r) => !installation.permissions.includes(r));
    if (reconnectMissing.length > 0) {
      return {
        outcome: 'BLOCKED',
        code: 'MISSING_PERMISSIONS',
        detail: `installation lacks required permissions: ${reconnectMissing.join(', ')}`,
      };
    }

    const existing = await this.persistence.findByGithubRepositoryId(input.githubRepositoryId);
    if (existing) {
      // Idempotent reconnect: refresh metadata, restore degraded state.
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

    // Verify required read permissions from the installation snapshot.
    const required = ['contents: read', 'issues: read', 'metadata: read'];
    const missing = required.filter((r) => !installation.permissions.includes(r));
    if (missing.length > 0) {
      return {
        outcome: 'BLOCKED',
        code: 'MISSING_PERMISSIONS',
        detail: `installation lacks required permissions: ${missing.join(', ')}`,
      };
    }

    // Seed the conservative default policy + insert the aggregate atomically:
    // both writes happen under the real persisted repository id in one
    // transaction, so a failure rolls back both (no orphan policy, no
    // synthetic/temporary id binding).
    const record = await this.persistence.onboardRepository({
      githubRepositoryId: input.githubRepositoryId,
      installationId: input.installationId,
      ownerLogin: input.ownerLogin,
      repoName: input.repoName,
      defaultBranch: input.defaultBranch,
      visibility: input.visibility,
      seedPolicy: (repositoryDevguardId) =>
        this.policySeeder.seedDefaultPolicy({ repositoryDevguardId }),
    });
    return { outcome: 'CONNECTED', record };
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

  /**
   * Reconcile repository lifecycle projections from a GitHub installation
   * webhook signal. Suspension/removal degrade or disconnect every repository
   * under the installation; unsuspension and permission changes verify the
   * installation and restore connectivity. Fail closed: an inactive
   * installation can never leave projections connected.
   */
  async applyInstallationSignal(input: {
    installationId: string;
    signal: 'suspended' | 'unsuspended' | 'removed' | 'permissions_changed';
  }): Promise<void> {
    const repositories = await this.persistence.findByInstallationId(input.installationId);

    if (input.signal === 'suspended' || input.signal === 'removed') {
      // The installation can no longer grant access: the projection must not
      // stay connected/degraded-as-if-usable. Removal is terminal-ish →
      // disconnect; suspension is transient → degrade with a stable reason.
      if (input.signal === 'removed') {
        for (const repo of repositories) {
          if (repo.status === 'disconnected') continue;
          await this.persistence.updateStatus({
            repositoryDevguardId: repo.repositoryDevguardId,
            status: 'disconnected',
            lastSyncedAtIso: new Date().toISOString(),
          });
        }
        return;
      }
      for (const repo of repositories) {
        if (repo.status === 'degraded' && repo.degradedReasonCode === 'INSTALLATION_SUSPENDED') {
          continue;
        }
        await this.persistence.updateStatus({
          repositoryDevguardId: repo.repositoryDevguardId,
          status: 'degraded',
          degradedReasonCode: 'INSTALLATION_SUSPENDED',
          lastSyncedAtIso: new Date().toISOString(),
        });
      }
      return;
    }

    // Unsuspension / permission change: verify the installation is active
    // before restoring connectivity (fail closed on an inactive install).
    const installation = await this.installationPort.verifyInstallation(input.installationId);
    if (!installation.active) {
      for (const repo of repositories) {
        if (repo.status === 'disconnected') continue;
        await this.persistence.updateStatus({
          repositoryDevguardId: repo.repositoryDevguardId,
          status: 'disconnected',
          lastSyncedAtIso: new Date().toISOString(),
        });
      }
      return;
    }
    for (const repo of repositories) {
      if (repo.status === 'connected') continue;
      await this.persistence.updateStatus({
        repositoryDevguardId: repo.repositoryDevguardId,
        status: 'connected',
        lastSyncedAtIso: new Date().toISOString(),
      });
    }
  }
}

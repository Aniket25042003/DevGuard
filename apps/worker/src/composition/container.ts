/**
 * C006 — Worker composition root.
 *
 * Workers act ONLY as scoped system actors bound to persisted runs/approvals.
 * No user principals exist here; forged user actors cannot be constructed.
 */
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
} from '@devguard/authorization';
import type { WorkerConfigSnapshot } from '@devguard/config';

/** Shared fail-closed stubs until their owning components land. */
export class UnavailableGitHubPermissionPort implements GitHubPermissionPort {
  async fetchUserRole(): Promise<{ role: 'none'; snapshotHash: string }> {
    throw new Error('github_permission_port_unavailable');
  }
}

export class EmptyLocalRepositoryAccessPort implements LocalRepositoryAccessPort {
  async findLinkage(): Promise<undefined> {
    return undefined;
  }

  async isConnectingOwner(): Promise<boolean> {
    return false;
  }
}

export interface WorkerContainer {
  readonly config: WorkerConfigSnapshot;
  readonly authorizer: RepositoryAuthorizationService;
}

export function buildWorkerContainer(config: WorkerConfigSnapshot): WorkerContainer {
  const localAccess: LocalRepositoryAccessPort = new EmptyLocalRepositoryAccessPort();
  const githubPermissions: GitHubPermissionPort = new UnavailableGitHubPermissionPort();
  const evidence: AuthorizationEvidencePort = new (class implements AuthorizationEvidencePort {
    private readonly rows: Parameters<AuthorizationEvidencePort['append']>[0][] = [];
    async append(record: Parameters<AuthorizationEvidencePort['append']>[0]): Promise<void> {
      this.rows.push(record);
    }
    async findFresh(): Promise<undefined> {
      // System-actor capabilities are always fresh-checked; no cache reads.
      return undefined;
    }
  })();

  const authorizer = new RepositoryAuthorizationService({
    local: localAccess,
    github: githubPermissions,
    evidence,
    readCacheTtlSeconds: 0,
    now: () => new Date(),
  });
  return { config, authorizer };
}

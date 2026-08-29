import type { GitHubPermissionPort, LocalRepositoryAccessPort } from '@devguard/authorization';

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

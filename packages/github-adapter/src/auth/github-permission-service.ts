/**
 * C017/C006 — durable GitHub permission evidence via installation token + collaborator API.
 */
import type { GitHubTransport } from '../core/client.js';
import {
  GitHubCollaboratorRoleService,
  type NormalizedGitHubRole,
} from './github-collaborator-role.js';
import {
  InMemoryTokenLeaseCache,
  TokenLeaseManager,
  type InstallationTokenMintPort,
} from './token-lease-cache.js';

export interface GitHubPermissionLookupContext {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly userLogin: string;
  readonly githubRepositoryId: string;
}

export interface GitHubPermissionContextPort {
  resolve(input: {
    readonly installationRef: string;
    readonly repositoryExternalIdHint?: string | undefined;
    readonly providerSubject: string;
  }): Promise<GitHubPermissionLookupContext | undefined>;
}

export interface GitHubPermissionServiceDeps {
  readonly context: GitHubPermissionContextPort;
  readonly mint: InstallationTokenMintPort;
  readonly transport: GitHubTransport;
  readonly credentialVersion: string;
  readonly nowMs?: () => number;
}

export class GitHubPermissionService {
  private readonly roles: GitHubCollaboratorRoleService;
  private readonly tokens: TokenLeaseManager;

  constructor(private readonly deps: GitHubPermissionServiceDeps) {
    this.roles = new GitHubCollaboratorRoleService(deps.transport);
    this.tokens = new TokenLeaseManager(
      new InMemoryTokenLeaseCache(),
      deps.mint,
      deps.nowMs ?? (() => Date.now()),
    );
  }

  async fetchUserRole(input: {
    readonly installationRef: string;
    readonly repositoryExternalIdHint?: string | undefined;
    readonly providerSubject: string;
  }): Promise<{ role: NormalizedGitHubRole; snapshotHash: string }> {
    const context = await this.deps.context.resolve(input);
    if (context === undefined) {
      throw new Error('github_permission_context_unresolved');
    }
    const lease = await this.tokens.acquire(
      `perm:${context.githubInstallationId}:${context.githubRepositoryId}:${input.providerSubject}`,
      context.githubInstallationId,
      [context.githubRepositoryId],
      ['repository.metadata.read'],
      this.deps.credentialVersion,
    );
    return this.roles.fetchRole({
      token: lease.token,
      owner: context.owner,
      repo: context.repo,
      userLogin: context.userLogin,
    });
  }
}

export type GitHubPermissionPortShape = {
  fetchUserRole(input: {
    readonly installationRef: string;
    readonly repositoryExternalIdHint?: string | undefined;
    readonly providerSubject: string;
  }): Promise<{ role: NormalizedGitHubRole; snapshotHash: string }>;
};

export function asGitHubPermissionPort(
  service: GitHubPermissionService,
): GitHubPermissionPortShape {
  return {
    fetchUserRole: (input) => service.fetchUserRole(input),
  };
}

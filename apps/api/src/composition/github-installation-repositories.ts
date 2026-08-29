/**
 * Lists GitHub repositories for an installation the signed-in user has linked.
 */
import type { GithubAppConfig } from '@devguard/config';
import type { DevGuardPool } from '@devguard/db';
import { ConnectedRepositoryStore, InstallationStore } from '@devguard/db';
import {
  AppJwtSigner,
  FetchTransport,
  InMemoryKeyProvider,
  listInstallationRepositories,
  normalizePrivateKeyPem,
} from '@devguard/github-adapter';

export interface InstallationRepositoryListItem {
  readonly id: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly archived: boolean;
  readonly connected: boolean;
  readonly status?: string | undefined;
}

export async function listGitHubInstallationRepositories(input: {
  readonly pool: DevGuardPool;
  readonly github: GithubAppConfig;
  readonly privateKeyPem: string;
  readonly userId: string;
  readonly installationRef: string;
  readonly cursor?: string | undefined;
  readonly query?: string | undefined;
}): Promise<{ readonly repositories: readonly InstallationRepositoryListItem[]; readonly nextCursor?: string }> {
  const installStore = new InstallationStore(input.pool);
  const repoStore = new ConnectedRepositoryStore(input.pool);
  const installations = await installStore.listForUser(input.userId);
  const installation = installations.find(
    (item) => item.id === input.installationRef || item.githubInstallationId === input.installationRef,
  );
  if (installation === undefined) {
    throw new Error('installation_not_linked');
  }
  const page = input.cursor !== undefined && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 1;
  const transport = new FetchTransport();
  const signer = new AppJwtSigner({ nowMs: () => Date.now() });
  const keyProvider = new InMemoryKeyProvider({
    appId: input.github.appId,
    privateKeyPem: normalizePrivateKeyPem(input.privateKeyPem),
    keyVersion: 'v1',
  });
  const listed = await listInstallationRepositories({
    transport,
    signer,
    keyProvider,
    installationId: installation.githubInstallationId,
    page,
  });
  const connected = await repoStore.listForUser(input.userId);
  const connectedByGithubId = new Map(
    connected
      .filter((repo) => repo.installationId === installation.id)
      .map((repo) => [String(repo.githubRepositoryId), repo]),
  );
  const needle = input.query?.trim().toLowerCase();
  const repositories = listed.repositories
    .filter((repo) => {
      if (needle === undefined || needle.length === 0) return true;
      return (
        repo.fullName.toLowerCase().includes(needle) ||
        repo.repoName.toLowerCase().includes(needle) ||
        repo.ownerLogin.toLowerCase().includes(needle)
      );
    })
    .map((repo) => {
      const linked = connectedByGithubId.get(repo.githubRepositoryId);
      return {
        id: linked?.id ?? repo.githubRepositoryId,
        githubRepositoryId: repo.githubRepositoryId,
        owner: repo.ownerLogin,
        name: repo.repoName,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        visibility: repo.visibility,
        archived: repo.archived,
        connected: linked !== undefined,
        ...(linked !== undefined ? { status: linked.status } : {}),
      };
    });
  return {
    repositories,
    ...(listed.nextPage !== undefined ? { nextCursor: String(listed.nextPage) } : {}),
  };
}

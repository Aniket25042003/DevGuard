/**
 * List repositories accessible to a GitHub App installation (app JWT).
 */
import type { GitHubTransport } from '../core/client.js';
import type { AppJwtSigner, SecretKeyProvider } from './app-jwt-signer.js';

const API_VERSION = '2022-11-28';
const DEFAULT_PER_PAGE = 100;

export interface InstallationRepositoryCandidate {
  readonly githubRepositoryId: string;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly archived: boolean;
}

export interface ListInstallationRepositoriesOptions {
  readonly transport: GitHubTransport;
  readonly signer: AppJwtSigner;
  readonly keyProvider: SecretKeyProvider;
  readonly installationId: string;
  readonly page?: number | undefined;
  readonly perPage?: number | undefined;
  readonly apiVersion?: string | undefined;
}

export interface ListInstallationRepositoriesResult {
  readonly repositories: readonly InstallationRepositoryCandidate[];
  readonly nextPage?: number | undefined;
}

export async function listInstallationRepositories(
  options: ListInstallationRepositoriesOptions,
): Promise<ListInstallationRepositoriesResult> {
  const key = await options.keyProvider.load();
  const signed = options.signer.sign(key);
  const page = options.page ?? 1;
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const response = await options.transport.request({
    method: 'GET',
    path: `/app/installations/${encodeURIComponent(options.installationId)}/repositories?per_page=${perPage}&page=${page}`,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${signed.jwt.expose()}`,
      'x-github-api-version': options.apiVersion ?? API_VERSION,
    },
    timeoutMs: 30_000,
    host: 'api.github.com',
  });
  if (response.status !== 200) {
    throw new Error(`github_installation_repos_fetch_failed:${response.status}`);
  }
  const body = JSON.parse(response.bodyText ?? '{}') as Record<string, unknown>;
  const rawRepos = body['repositories'];
  if (!Array.isArray(rawRepos)) {
    throw new Error('github_installation_repos_shape_invalid');
  }
  const repositories: InstallationRepositoryCandidate[] = [];
  for (const entry of rawRepos) {
    if (entry === null || typeof entry !== 'object') continue;
    const repo = entry as Record<string, unknown>;
    const id = repo['id'];
    const name = repo['name'];
    const fullName = repo['full_name'];
    const owner =
      repo['owner'] !== null && typeof repo['owner'] === 'object'
        ? (repo['owner'] as Record<string, unknown>)
        : undefined;
    const ownerLogin = owner?.['login'];
    if (
      typeof id !== 'number' ||
      typeof name !== 'string' ||
      typeof fullName !== 'string' ||
      typeof ownerLogin !== 'string'
    ) {
      continue;
    }
    repositories.push({
      githubRepositoryId: String(id),
      ownerLogin,
      repoName: name,
      fullName,
      defaultBranch: typeof repo['default_branch'] === 'string' ? repo['default_branch'] : 'main',
      visibility: repo['private'] === true ? 'private' : 'public',
      archived: repo['archived'] === true,
    });
  }
  const nextPage = repositories.length >= perPage ? page + 1 : undefined;
  return { repositories, ...(nextPage !== undefined ? { nextPage } : {}) };
}

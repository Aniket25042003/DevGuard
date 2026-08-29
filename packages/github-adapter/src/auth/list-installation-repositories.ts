/**
 * List repositories accessible to a GitHub App installation.
 *
 * Uses an installation access token (minted with an app JWT) because GitHub's
 * installation-scoped repository listing is the supported path for repo data.
 */
import type { GitHubTransport } from '../core/client.js';
import { SecretString } from './contracts.js';
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

function parseRepositoryCandidates(rawRepos: unknown): InstallationRepositoryCandidate[] {
  if (!Array.isArray(rawRepos)) return [];
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
  return repositories;
}

async function mintInstallationAccessToken(
  options: ListInstallationRepositoriesOptions,
): Promise<SecretString> {
  const key = await options.keyProvider.load();
  const signed = options.signer.sign(key);
  const response = await options.transport.request({
    method: 'POST',
    path: `/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${signed.jwt.expose()}`,
      'x-github-api-version': options.apiVersion ?? API_VERSION,
      'content-type': 'application/json',
    },
    body: '{}',
    timeoutMs: 30_000,
    host: 'api.github.com',
  });
  if (response.status !== 201) {
    throw new Error(`github_installation_token_mint_failed:${response.status}`);
  }
  const parsed = JSON.parse(response.bodyText ?? '{}') as { token?: string };
  if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
    throw new Error('github_installation_token_mint_shape_invalid');
  }
  return new SecretString(parsed.token);
}

async function listWithInstallationToken(
  options: ListInstallationRepositoriesOptions,
  installationToken: SecretString,
): Promise<ListInstallationRepositoriesResult> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const response = await options.transport.request({
    method: 'GET',
    path: `/installation/repositories?per_page=${perPage}&page=${page}`,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${installationToken.expose()}`,
      'x-github-api-version': options.apiVersion ?? API_VERSION,
    },
    timeoutMs: 30_000,
    host: 'api.github.com',
  });
  if (response.status !== 200) {
    throw new Error(`github_installation_repos_fetch_failed:${response.status}`);
  }
  const body = JSON.parse(response.bodyText ?? '{}') as Record<string, unknown>;
  const repositories = parseRepositoryCandidates(body['repositories']);
  const nextPage = repositories.length >= perPage ? page + 1 : undefined;
  return { repositories, ...(nextPage !== undefined ? { nextPage } : {}) };
}

async function listWithAppJwt(
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
  const repositories = parseRepositoryCandidates(body['repositories']);
  const nextPage = repositories.length >= perPage ? page + 1 : undefined;
  return { repositories, ...(nextPage !== undefined ? { nextPage } : {}) };
}

export async function listInstallationRepositories(
  options: ListInstallationRepositoriesOptions,
): Promise<ListInstallationRepositoriesResult> {
  try {
    const installationToken = await mintInstallationAccessToken(options);
    return await listWithInstallationToken(options, installationToken);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('github_installation_token_mint_failed:') ||
        error.message === 'github_installation_token_mint_shape_invalid')
    ) {
      return listWithAppJwt(options);
    }
    throw error;
  }
}

export { parseRepositoryCandidates };

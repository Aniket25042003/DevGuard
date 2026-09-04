/**
 * List pull requests, issues, and branches for a connected repository.
 */
import type { GitHubTransport } from '../core/client.js';
import type { SecretString } from '../auth/contracts.js';

const API_VERSION = '2022-11-28';

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly authorLogin: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly draft: boolean;
}

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly authorLogin: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly labels: readonly string[];
}

export interface GitRefSummary {
  readonly name: string;
  readonly commitSha: string;
  readonly isDefault: boolean;
  readonly protected: boolean;
}

export interface ListRepositoryTargetsOptions {
  readonly transport: GitHubTransport;
  readonly token: SecretString;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch?: string | undefined;
  readonly perPage?: number | undefined;
  readonly page?: number | undefined;
  readonly apiVersion?: string | undefined;
}

function authorLogin(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const login = (value as Record<string, unknown>)['login'];
    if (typeof login === 'string' && login.length > 0) return login;
  }
  return 'unknown';
}

function requestGitHub(
  options: ListRepositoryTargetsOptions,
  path: string,
): Promise<{ readonly status: number; readonly bodyText: string | undefined }> {
  return options.transport.request({
    method: 'GET',
    path,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${options.token.expose()}`,
      'x-github-api-version': options.apiVersion ?? API_VERSION,
    },
    timeoutMs: 30_000,
    host: 'api.github.com',
  });
}

export async function listRepositoryPullRequests(
  options: ListRepositoryTargetsOptions & { readonly state?: 'open' | 'closed' | 'all' },
): Promise<readonly PullRequestSummary[]> {
  const perPage = options.perPage ?? 30;
  const page = options.page ?? 1;
  const state = options.state ?? 'open';
  const response = await requestGitHub(
    options,
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
  );
  if (response.status !== 200) {
    throw new Error(`github_pull_requests_fetch_failed:${response.status}`);
  }
  const raw = JSON.parse(response.bodyText ?? '[]') as unknown;
  if (!Array.isArray(raw)) return [];
  const pullRequests: PullRequestSummary[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const number = row['number'];
    const title = row['title'];
    const htmlUrl = row['html_url'];
    const updatedAt = row['updated_at'];
    const stateValue = row['state'];
    if (
      typeof number !== 'number' ||
      typeof title !== 'string' ||
      typeof htmlUrl !== 'string' ||
      typeof updatedAt !== 'string' ||
      (stateValue !== 'open' && stateValue !== 'closed')
    ) {
      continue;
    }
    const head =
      row['head'] !== null && typeof row['head'] === 'object'
        ? (row['head'] as Record<string, unknown>)
        : undefined;
    const base =
      row['base'] !== null && typeof row['base'] === 'object'
        ? (row['base'] as Record<string, unknown>)
        : undefined;
    pullRequests.push({
      number,
      title,
      state: stateValue,
      authorLogin: authorLogin(row['user']),
      updatedAt,
      htmlUrl,
      headRef: typeof head?.['ref'] === 'string' ? head['ref'] : 'unknown',
      baseRef: typeof base?.['ref'] === 'string' ? base['ref'] : 'main',
      draft: row['draft'] === true,
    });
  }
  return pullRequests;
}

export async function listRepositoryIssues(
  options: ListRepositoryTargetsOptions & { readonly state?: 'open' | 'closed' | 'all' },
): Promise<readonly IssueSummary[]> {
  const perPage = options.perPage ?? 30;
  const page = options.page ?? 1;
  const state = options.state ?? 'open';
  const response = await requestGitHub(
    options,
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
  );
  if (response.status !== 200) {
    throw new Error(`github_issues_fetch_failed:${response.status}`);
  }
  const raw = JSON.parse(response.bodyText ?? '[]') as unknown;
  if (!Array.isArray(raw)) return [];
  const issues: IssueSummary[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row['pull_request'] !== undefined && row['pull_request'] !== null) continue;
    const number = row['number'];
    const title = row['title'];
    const htmlUrl = row['html_url'];
    const updatedAt = row['updated_at'];
    const stateValue = row['state'];
    if (
      typeof number !== 'number' ||
      typeof title !== 'string' ||
      typeof htmlUrl !== 'string' ||
      typeof updatedAt !== 'string' ||
      (stateValue !== 'open' && stateValue !== 'closed')
    ) {
      continue;
    }
    const labelsRaw = Array.isArray(row['labels']) ? row['labels'] : [];
    const labels = labelsRaw
      .map((label) => {
        if (typeof label === 'string') return label;
        if (label !== null && typeof label === 'object') {
          const name = (label as Record<string, unknown>)['name'];
          return typeof name === 'string' ? name : undefined;
        }
        return undefined;
      })
      .filter((label): label is string => label !== undefined);
    issues.push({
      number,
      title,
      state: stateValue,
      authorLogin: authorLogin(row['user']),
      updatedAt,
      htmlUrl,
      labels,
    });
  }
  return issues;
}

export async function listRepositoryRefs(
  options: ListRepositoryTargetsOptions,
): Promise<readonly GitRefSummary[]> {
  const perPage = options.perPage ?? 30;
  const page = options.page ?? 1;
  const response = await requestGitHub(
    options,
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/branches?per_page=${perPage}&page=${page}`,
  );
  if (response.status !== 200) {
    throw new Error(`github_refs_fetch_failed:${response.status}`);
  }
  const raw = JSON.parse(response.bodyText ?? '[]') as unknown;
  if (!Array.isArray(raw)) return [];
  const defaultBranch = options.defaultBranch ?? 'main';
  const refs: GitRefSummary[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = row['name'];
    if (typeof name !== 'string') continue;
    const commit =
      row['commit'] !== null && typeof row['commit'] === 'object'
        ? (row['commit'] as Record<string, unknown>)
        : undefined;
    const sha = commit?.['sha'];
    refs.push({
      name,
      commitSha: typeof sha === 'string' ? sha : '',
      isDefault: name === defaultBranch,
      protected: row['protected'] === true,
    });
  }
  refs.sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return refs;
}

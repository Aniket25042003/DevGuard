/**
 * GitHub-backed launch targets for a connected repository (PRs, issues, refs).
 */
import type { GithubAppConfig } from '@devguard/config';
import type { DevGuardPool } from '@devguard/db';
import {
  AppJwtSigner,
  FetchInstallationTokenMintPort,
  FetchTransport,
  InMemoryKeyProvider,
  InMemoryTokenLeaseCache,
  SecretString,
  TokenLeaseManager,
  listRepositoryIssues,
  listRepositoryPullRequests,
  listRepositoryRefs,
  normalizePrivateKeyPem,
  type GitRefSummary,
  type IssueSummary,
  type PullRequestSummary,
} from '@devguard/github-adapter';

const TARGET_CACHE_TTL_MS = 30_000;

interface RepositoryGitHubContext {
  readonly owner: string;
  readonly name: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly defaultBranch: string;
}

interface CacheEntry<T> {
  readonly expiresAt: number;
  readonly value: T;
}

const targetCache = new Map<string, CacheEntry<unknown>>();

function readCache<T>(key: string): T | undefined {
  const entry = targetCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    targetCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function writeCache<T>(key: string, value: T): void {
  targetCache.set(key, { expiresAt: Date.now() + TARGET_CACHE_TTL_MS, value });
}

function filterByQuery<T extends { readonly title: string; readonly number: number }>(
  items: readonly T[],
  query: string | undefined,
): readonly T[] {
  const needle = query?.trim().toLowerCase();
  if (needle === undefined || needle.length === 0) return items;
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) || String(item.number).includes(needle),
  );
}

async function resolveRepositoryContext(
  pool: DevGuardPool,
  repositoryId: string,
): Promise<RepositoryGitHubContext | undefined> {
  const rows = await pool.query<Record<string, unknown>>({
    text: `
SELECT r.owner,
       r.name,
       r.github_repository_id::text AS github_repository_id,
       COALESCE(r.default_branch, 'main') AS default_branch,
       gi.github_installation_id::text AS github_installation_id
FROM repositories r
JOIN github_installations gi ON gi.id = r.installation_id
WHERE r.id = $1::uuid
LIMIT 1`,
    values: [repositoryId],
  });
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    owner: String(row['owner']),
    name: String(row['name']),
    githubRepositoryId: String(row['github_repository_id']),
    githubInstallationId: String(row['github_installation_id']),
    defaultBranch: String(row['default_branch']),
  };
}

function createTokenManager(github: GithubAppConfig, privateKeyPem: string): TokenLeaseManager {
  const transport = new FetchTransport();
  const signer = new AppJwtSigner({ nowMs: () => Date.now() });
  const keyProvider = new InMemoryKeyProvider({
    appId: github.appId,
    privateKeyPem: normalizePrivateKeyPem(privateKeyPem),
    keyVersion: 'v1',
  });
  const mint = new FetchInstallationTokenMintPort({ transport, signer, keyProvider });
  return new TokenLeaseManager(new InMemoryTokenLeaseCache(), mint, () => Date.now());
}

async function acquireRepositoryToken(
  tokens: TokenLeaseManager,
  context: RepositoryGitHubContext,
): Promise<SecretString> {
  const lease = await tokens.acquire(
    `targets:${context.githubInstallationId}:${context.githubRepositoryId}`,
    context.githubInstallationId,
    [context.githubRepositoryId],
    ['repository.metadata.read', 'pull_request.read', 'issue.read', 'branch.read'],
    'v1',
  );
  return lease.token;
}

export async function listRepositoryPullRequestTargets(input: {
  readonly pool: DevGuardPool;
  readonly github: GithubAppConfig;
  readonly privateKeyPem: string;
  readonly repositoryId: string;
  readonly state?: 'open' | 'closed' | 'all' | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<{ readonly pullRequests: readonly PullRequestSummary[] }> {
  const cacheKey = `prs:${input.repositoryId}:${input.state ?? 'open'}:${input.limit ?? 25}`;
  const cached = readCache<readonly PullRequestSummary[]>(cacheKey);
  if (cached !== undefined) {
    return { pullRequests: filterByQuery(cached, input.query).slice(0, input.limit ?? 25) };
  }
  const context = await resolveRepositoryContext(input.pool, input.repositoryId);
  if (context === undefined) throw new Error('repository_not_found');
  const tokens = createTokenManager(input.github, input.privateKeyPem);
  const token = await acquireRepositoryToken(tokens, context);
  const transport = new FetchTransport();
  const pullRequests = await listRepositoryPullRequests({
    transport,
    token,
    owner: context.owner,
    repo: context.name,
    perPage: Math.min(input.limit ?? 25, 100),
    state: input.state ?? 'open',
  });
  writeCache(cacheKey, pullRequests);
  return {
    pullRequests: filterByQuery(pullRequests, input.query).slice(0, input.limit ?? 25),
  };
}

export async function listRepositoryIssueTargets(input: {
  readonly pool: DevGuardPool;
  readonly github: GithubAppConfig;
  readonly privateKeyPem: string;
  readonly repositoryId: string;
  readonly state?: 'open' | 'closed' | 'all' | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<{ readonly issues: readonly IssueSummary[] }> {
  const cacheKey = `issues:${input.repositoryId}:${input.state ?? 'open'}:${input.limit ?? 25}`;
  const cached = readCache<readonly IssueSummary[]>(cacheKey);
  if (cached !== undefined) {
    return { issues: filterByQuery(cached, input.query).slice(0, input.limit ?? 25) };
  }
  const context = await resolveRepositoryContext(input.pool, input.repositoryId);
  if (context === undefined) throw new Error('repository_not_found');
  const tokens = createTokenManager(input.github, input.privateKeyPem);
  const token = await acquireRepositoryToken(tokens, context);
  const transport = new FetchTransport();
  const issues = await listRepositoryIssues({
    transport,
    token,
    owner: context.owner,
    repo: context.name,
    perPage: Math.min(input.limit ?? 25, 100),
    state: input.state ?? 'open',
  });
  writeCache(cacheKey, issues);
  return { issues: filterByQuery(issues, input.query).slice(0, input.limit ?? 25) };
}

export async function listRepositoryRefTargets(input: {
  readonly pool: DevGuardPool;
  readonly github: GithubAppConfig;
  readonly privateKeyPem: string;
  readonly repositoryId: string;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<{ readonly refs: readonly GitRefSummary[] }> {
  const cacheKey = `refs:${input.repositoryId}:${input.limit ?? 25}`;
  const cached = readCache<readonly GitRefSummary[]>(cacheKey);
  if (cached !== undefined) {
    const needle = input.query?.trim().toLowerCase();
    const filtered =
      needle === undefined || needle.length === 0
        ? cached
        : cached.filter((ref) => ref.name.toLowerCase().includes(needle));
    return { refs: filtered.slice(0, input.limit ?? 25) };
  }
  const context = await resolveRepositoryContext(input.pool, input.repositoryId);
  if (context === undefined) throw new Error('repository_not_found');
  const tokens = createTokenManager(input.github, input.privateKeyPem);
  const token = await acquireRepositoryToken(tokens, context);
  const transport = new FetchTransport();
  const refs = await listRepositoryRefs({
    transport,
    token,
    owner: context.owner,
    repo: context.name,
    defaultBranch: context.defaultBranch,
    perPage: Math.min(input.limit ?? 25, 100),
  });
  writeCache(cacheKey, refs);
  const needle = input.query?.trim().toLowerCase();
  const filtered =
    needle === undefined || needle.length === 0
      ? refs
      : refs.filter((ref) => ref.name.toLowerCase().includes(needle));
  return { refs: filtered.slice(0, input.limit ?? 25) };
}

export async function listRepositorySecurityFindingTargets(input: {
  readonly pool: DevGuardPool;
  readonly repositoryId: string;
  readonly status?: 'open' | 'confirmed' | 'all' | undefined;
  readonly limit?: number | undefined;
}): Promise<{
  readonly findings: readonly {
    readonly id: string;
    readonly severity: string;
    readonly status: string;
    readonly title: string;
    readonly rule?: string;
    readonly filePath?: string;
    readonly autoFixable: boolean;
  }[];
}> {
  const statuses =
    input.status === 'all' || input.status === undefined
      ? ['open', 'confirmed']
      : [input.status];
  const rows = await input.pool.query<Record<string, unknown>>({
    text: `
SELECT id::text AS id,
       severity,
       status,
       COALESCE(category, '') AS category,
       title,
       file_path,
       auto_fixable
FROM security_findings
WHERE repository_id = $1::uuid
  AND status = ANY($2::text[])
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    ELSE 5
  END,
  updated_at DESC
LIMIT $3`,
    values: [input.repositoryId, statuses, Math.min(input.limit ?? 25, 100)],
  });
  return {
    findings: rows.map((row) => ({
      id: String(row['id']),
      severity: String(row['severity']),
      status: String(row['status']),
      title: String(row['title']),
      ...(String(row['category'] ?? '').length > 0 ? { rule: String(row['category']) } : {}),
      ...(row['file_path'] !== null && row['file_path'] !== undefined
        ? { filePath: String(row['file_path']) }
        : {}),
      autoFixable: row['auto_fixable'] === true,
    })),
  };
}

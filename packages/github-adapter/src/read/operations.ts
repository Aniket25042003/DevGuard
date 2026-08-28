/**
 * C019 §8/§10 — read-only operation descriptors and normalized output types.
 *
 * Every method is a separate typed read operation registered through C024.
 * Provider types stop here; outputs are DevGuard-normalized with provenance,
 * hashes, and explicit truncation states. No write path exists on this port.
 */
import { z } from 'zod';
import type { GitHubOperation } from '../core/contracts.js';

const GITHUB_API_VERSION = '2022-11-28';

const repoId = z.number().int().positive();
const issueNumber = z.number().int().positive().max(10_000_000);
const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const repoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.startsWith('/'), 'absolute paths are not repository-relative')
  .refine(
    (v) => !v.split('/').includes('..'),
    'parent traversal outside repository root is rejected',
  )
  .refine((v) => !v.includes('\0'), 'NUL bytes are rejected');

// ---- normalized output types (DevGuard-owned, no SDK types) ---------------

export interface GitHubRepository {
  readonly githubRepositoryId: number;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly archived: boolean;
  readonly fork: boolean;
}

export interface GitHubIssue {
  readonly githubIssueId: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly authorLogin: string;
  readonly commentsCount: number;
}

export interface GitHubComment {
  readonly githubCommentId: number;
  readonly body: string;
  readonly authorLogin: string;
}

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly kind: 'blob' | 'tree' | 'commit';
  readonly objectSha: string;
  readonly size?: number | undefined;
}

export interface GitTreePage {
  readonly sha: string;
  readonly entries: readonly GitTreeEntry[];
  readonly truncated: boolean;
}

export interface GitFile {
  readonly path: string;
  readonly ref: string;
  readonly blobSha: string;
  readonly sizeBytes: number;
  readonly encoding: 'text' | 'binary';
  /** Text content if within bounds; absent for binary/truncated. */
  readonly text?: string | undefined;
  readonly truncated: boolean;
}

// ---- zod output schemas (normalizers for GitHub response shapes) ----------

const outputRepository = z
  .object({
    id: repoId,
    owner: z.object({ login: z.string().min(1) }).transform((o) => o.login),
    name: z.string().min(1),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
    visibility: z.enum(['public', 'private']).default('public'),
    archived: z.boolean(),
    fork: z.boolean(),
  })
  .transform((raw) => ({
    githubRepositoryId: raw.id,
    ownerLogin: raw.owner,
    repoName: raw.name,
    fullName: raw.full_name,
    defaultBranch: raw.default_branch,
    visibility: raw.visibility,
    archived: raw.archived,
    fork: raw.fork,
  }));

const outputIssue = z
  .object({
    id: repoId,
    number: issueNumber,
    title: z.string(),
    body: z
      .string()
      .nullable()
      .transform((body) => body ?? ''),
    state: z.enum(['open', 'closed']),
    labels: z
      .array(z.object({ name: z.string() }))
      .transform((labels) => labels.map((l) => l.name)),
    user: z
      .object({ login: z.string() })
      .nullable()
      .transform((u) => u?.login ?? 'ghost'),
    comments: z.number().int().nonnegative(),
  })
  .transform((raw) => ({
    githubIssueId: raw.id,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    labels: raw.labels,
    authorLogin: raw.user,
    commentsCount: raw.comments,
  }));

const outputComment = z
  .object({
    id: repoId,
    body: z.string(),
    user: z
      .object({ login: z.string() })
      .nullable()
      .transform((u) => u?.login ?? 'ghost'),
  })
  .transform((raw) => ({
    githubCommentId: raw.id,
    body: raw.body,
    authorLogin: raw.user,
  }));

const outputFile = z.object({
  path: z.string().min(1),
  sha: sha40,
  size: z.number().int().nonnegative(),
  content: z.string().nullable(),
  encoding: z.enum(['base64', 'none']).optional(),
});

// ---- operation descriptors (C018 pattern) ---------------------------------

const inputRepoRef = z.object({ owner: z.string().min(1), repo: z.string().min(1) });
type RepoRef = z.output<typeof inputRepoRef>;

export const OP_GET_REPOSITORY: GitHubOperation<{ owner: string; repo: string }, GitHubRepository> =
  {
    operationId: 'github.get-repository',
    method: 'GET',
    safety: 'read',
    pathTemplate: '/repos/{owner}/{repo}',
    inputSchema: inputRepoRef,
    outputSchema: outputRepository as never,
    successStatuses: [200],
    supportsConditional: true,
    paginationStyle: 'none',
    retrySafe: true,
  };

export const OP_GET_ISSUE: GitHubOperation<
  { owner: string; repo: string; issue_number: number },
  GitHubIssue
> = {
  operationId: 'github.get-issue',
  method: 'GET',
  safety: 'read',
  pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issue_number: issueNumber,
  }),
  outputSchema: outputIssue as never,
  successStatuses: [200],
  supportsConditional: true,
  paginationStyle: 'none',
  retrySafe: true,
};

export const OP_LIST_ISSUE_COMMENTS: GitHubOperation<
  { owner: string; repo: string; issue_number: number; per_page: number; page: number },
  GitHubComment[]
> = {
  operationId: 'github.list-issue-comments',
  method: 'GET',
  safety: 'read',
  pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issue_number: issueNumber,
    per_page: z.number().int().min(1).max(100),
    page: z.number().int().min(1),
  }),
  outputSchema: z.array(outputComment) as never,
  successStatuses: [200],
  supportsConditional: false,
  paginationStyle: 'link-header',
  retrySafe: true,
};

export const OP_RESOLVE_REF: GitHubOperation<
  { owner: string; repo: string; ref: string },
  { object: { sha: string } }
> = {
  operationId: 'github.resolve-ref',
  method: 'GET',
  safety: 'read',
  pathTemplate: '/repos/{owner}/{repo}/git/ref/{ref}',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().min(1).max(256),
  }),
  outputSchema: z.object({ object: z.object({ sha: sha40 }) }) as never,
  successStatuses: [200],
  supportsConditional: false,
  paginationStyle: 'none',
  retrySafe: true,
};

export const OP_GET_TREE: GitHubOperation<
  { owner: string; repo: string; commit_sha: string; recursive: string },
  {
    sha: string;
    tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
    truncated: boolean;
  }
> = {
  operationId: 'github.get-tree',
  method: 'GET',
  safety: 'read',
  pathTemplate: '/repos/{owner}/{repo}/git/trees/{commit_sha}',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    commit_sha: sha40,
    recursive: z.string(),
  }),
  outputSchema: z.object({
    sha: sha40,
    tree: z.array(
      z.object({
        path: z.string(),
        mode: z.string(),
        type: z.string(),
        sha: sha40,
        size: z.number().int().nonnegative().optional(),
      }),
    ),
    truncated: z.boolean(),
  }) as never,
  successStatuses: [200],
  supportsConditional: false,
  paginationStyle: 'none',
  retrySafe: true,
};

export const OP_GET_FILE: GitHubOperation<
  { owner: string; repo: string; commit_sha: string; path: string },
  { path: string; sha: string; size: number; content: string | null; encoding?: string }
> = {
  operationId: 'github.get-file',
  method: 'GET',
  safety: 'read',
  pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    commit_sha: sha40,
    path: repoPath,
  }),
  outputSchema: outputFile as never,
  successStatuses: [200],
  supportsConditional: true,
  paginationStyle: 'none',
  retrySafe: true,
};

export { GITHUB_API_VERSION, inputRepoRef, issueNumber, repoId, repoPath, sha40 };
export type { RepoRef };

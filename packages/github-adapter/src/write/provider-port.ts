/**
 * C020 §10/§12 — GitHub mutation provider port.
 *
 * Raw provider reads/writes are confined behind this port; the adapter maps
 * normalized DevGuard inputs to provider calls and normalizes every response.
 * Provider types never cross this boundary. The in-memory fake lets unit tests
 * exercise exact-state conflicts, ownership, timeouts (outcome_unknown), and
 * idempotent replays deterministically.
 */
import type {
  BrandedCommitSha,
  BrandedTreeSha,
  CommitTreeSpec,
  GitCommit,
  GitRepoRef,
  VerifiedCommitIdentity,
} from './contracts.js';

export type GitProviderErrorCode =
  'NOT_FOUND' | 'CONFLICT' | 'PERMISSION' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT';

export type GitProviderResult<T> =
  | { readonly ok: true; readonly value: T; readonly fetchedAtIso: string }
  | { readonly ok: false; readonly code: GitProviderErrorCode; readonly detail: string };

export interface CommitComparison {
  readonly ahead: number;
  readonly behind: number;
  readonly commits: readonly GitCommit[];
}

export interface GitHubMutationProviderPort {
  branchState(input: { repository: GitRepoRef; branch: string }): Promise<
    GitProviderResult<{
      exists: boolean;
      headSha?: string | undefined;
      protected?: boolean | undefined;
    }>
  >;

  getCommit(input: { repository: GitRepoRef; sha: string }): Promise<GitProviderResult<GitCommit>>;

  compareCommits(input: {
    repository: GitRepoRef;
    base: string;
    head: string;
    limit: number;
  }): Promise<GitProviderResult<CommitComparison>>;

  createRef(input: {
    repository: GitRepoRef;
    ref: string;
    sha: string;
  }): Promise<GitProviderResult<{ ref: string; sha: string }>>;

  createCommit(input: {
    repository: GitRepoRef;
    tree: CommitTreeSpec;
    parents: readonly string[];
    message: string;
    author?: VerifiedCommitIdentity | undefined;
  }): Promise<GitProviderResult<{ sha: string }>>;

  updateRef(input: {
    repository: GitRepoRef;
    ref: string;
    oldSha: string;
    newSha: string;
    force: false;
  }): Promise<GitProviderResult<{ ref: string; sha: string }>>;
}

/** Deterministic in-memory mutation provider for unit tests. */
export class InMemoryMutationProvider implements GitHubMutationProviderPort {
  readonly heads = new Map<string, string>();
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, GitCommit>();
  branchProtected = new Map<string, boolean>();
  failNext:
    | {
        op: 'any' | 'createRef' | 'createCommit' | 'updateRef' | 'branchState';
        code: GitProviderErrorCode;
      }
    | undefined;
  readonly calls: string[] = [];

  #fail(
    op: 'any' | 'createRef' | 'createCommit' | 'updateRef' | 'branchState',
  ):
    | { readonly ok: false; readonly code: GitProviderErrorCode; readonly detail: string }
    | undefined {
    if (this.failNext === undefined) return undefined;
    if (this.failNext.op === 'any' || this.failNext.op === op) {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected provider failure' };
    }
    return undefined;
  }

  refOf(_repository: GitRepoRef, branch: string): string {
    return `refs/heads/${branch}`;
  }

  seedBranch(
    repository: GitRepoRef,
    branch: string,
    headSha: string,
    protectedBranch = false,
  ): void {
    this.heads.set(this.refOf(repository, branch), headSha);
    if (protectedBranch) this.branchProtected.set(this.refOf(repository, branch), true);
  }

  seedCommit(commit: GitCommit): void {
    this.commits.set(commit.sha, commit);
  }

  async branchState(input: { repository: GitRepoRef; branch: string }): Promise<
    GitProviderResult<{
      exists: boolean;
      headSha?: string | undefined;
      protected?: boolean | undefined;
    }>
  > {
    this.calls.push('branchState');
    const failure = this.#fail('branchState');
    if (failure !== undefined) return failure;
    const key = this.refOf(input.repository, input.branch);
    const headSha = this.heads.get(key);
    if (headSha === undefined)
      return { ok: true, value: { exists: false }, fetchedAtIso: new Date().toISOString() };
    return {
      ok: true,
      value: { exists: true, headSha, protected: this.branchProtected.get(key) ?? false },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async getCommit(input: {
    repository: GitRepoRef;
    sha: string;
  }): Promise<GitProviderResult<GitCommit>> {
    this.calls.push('getCommit');
    const commit = this.commits.get(input.sha);
    return commit === undefined
      ? { ok: false, code: 'NOT_FOUND', detail: 'commit not found' }
      : { ok: true, value: commit, fetchedAtIso: new Date().toISOString() };
  }

  async compareCommits(input: {
    repository: GitRepoRef;
    base: string;
    head: string;
    limit: number;
  }): Promise<GitProviderResult<CommitComparison>> {
    this.calls.push('compareCommits');
    const base = this.commits.get(input.base);
    const head = this.commits.get(input.head);
    if (base === undefined || head === undefined) {
      return { ok: false, code: 'NOT_FOUND', detail: 'missing commit for comparison' };
    }
    const lambda = head.sha;
    let ahead = 0;
    let behind = 0;
    let cursor: string = lambda;
    let guard = 0;
    while (cursor !== input.base && guard < 1000) {
      const commit = this.commits.get(cursor);
      if (commit === undefined) break;
      ahead += 1;
      cursor = commit.parents[0] ?? cursor;
      guard += 1;
    }
    if (cursor !== input.base) behind = 1;
    return {
      ok: true,
      value: {
        ahead,
        behind,
        commits: [head, base],
      },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async createRef(input: {
    repository: GitRepoRef;
    ref: string;
    sha: string;
  }): Promise<GitProviderResult<{ ref: string; sha: string }>> {
    this.calls.push('createRef');
    const failure = this.#fail('createRef');
    if (failure !== undefined) return failure;
    if (this.refs.has(input.ref))
      return { ok: false, code: 'CONFLICT', detail: 'ref already exists' };
    this.refs.set(input.ref, input.sha);
    return {
      ok: true,
      value: { ref: input.ref, sha: input.sha },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async createCommit(input: {
    repository: GitRepoRef;
    tree: CommitTreeSpec;
    parents: readonly string[];
    message: string;
    author?: VerifiedCommitIdentity | undefined;
  }): Promise<GitProviderResult<{ sha: string }>> {
    this.calls.push('createCommit');
    const failure = this.#fail('createCommit');
    if (failure !== undefined) return failure;
    const sha =
      `c${(this.commits.size + 1).toString(16).padStart(39, '0').slice(0, 39)}` as BrandedCommitSha;
    const identity = input.author ?? {
      name: 'devguard',
      email: 'devguard@invalid',
      dateIso: new Date().toISOString(),
    };
    const treeSha = (input.tree.entries[0]?.sha?.slice(0, 40) ?? '0'.repeat(40)) as BrandedTreeSha;
    const commit: GitCommit = {
      sha,
      parents: [...input.parents],
      treeSha,
      author: identity,
      committer: identity,
      message: input.message,
      verification: 'unsigned',
      createdAtIso: new Date().toISOString(),
    };
    this.commits.set(sha, commit);
    return { ok: true, value: { sha }, fetchedAtIso: new Date().toISOString() };
  }

  async updateRef(input: {
    repository: GitRepoRef;
    ref: string;
    oldSha: string;
    newSha: string;
    force: false;
  }): Promise<GitProviderResult<{ ref: string; sha: string }>> {
    this.calls.push('updateRef');
    const failure = this.#fail('updateRef');
    if (failure !== undefined) return failure;
    const current = this.refs.get(input.ref) ?? this.heads.get(input.ref);
    if (current !== undefined && current !== input.oldSha) {
      return { ok: false, code: 'CONFLICT', detail: 'expected old SHA no longer matches' };
    }
    this.refs.set(input.ref, input.newSha);
    this.heads.set(input.ref, input.newSha);
    return {
      ok: true,
      value: { ref: input.ref, sha: input.newSha },
      fetchedAtIso: new Date().toISOString(),
    };
  }
}

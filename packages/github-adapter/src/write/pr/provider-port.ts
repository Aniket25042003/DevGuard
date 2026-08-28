/**
 * C021 §10/§12 — GitHub PR/review/check provider port.
 *
 * Raw PR/review/check reads/writes are confined behind this port; provider
 * types never cross. The in-memory fake gives deterministic unit control over
 * PR state, reviews/checks, comment posting, and merge behavior.
 */
import type {
  CreatePullRequest,
  GitRepoRef,
  MergePullRequest,
  PostPullRequestComment,
  PrRef,
  PullRequest,
  ReviewEvidence,
  UpdatePullRequest,
} from './contracts.js';

export type PrProviderErrorCode =
  'NOT_FOUND' | 'CONFLICT' | 'PERMISSION' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT';
export type PrProviderResult<T> =
  | { readonly ok: true; readonly value: T; readonly fetchedAtIso: string }
  | { readonly ok: false; readonly code: PrProviderErrorCode; readonly detail: string };

export interface PrProviderPort {
  getPullRequest(ref: PrRef): Promise<PrProviderResult<PullRequest>>;
  listEvidence(
    ref: PrRef,
    kinds: readonly string[],
    limit: number,
  ): Promise<PrProviderResult<readonly ReviewEvidence[]>>;
  getCheckEvidence(
    repository: GitRepoRef,
    commitSha: string,
    limit: number,
  ): Promise<PrProviderResult<readonly ReviewEvidence[]>>;
  createPullRequest(input: CreatePullRequest): Promise<PrProviderResult<PullRequest>>;
  updatePullRequest(input: UpdatePullRequest): Promise<PrProviderResult<PullRequest>>;
  postComment(input: PostPullRequestComment): Promise<PrProviderResult<{ providerId: string }>>;
  requestReview(
    repository: GitRepoRef,
    prNumber: number,
    reviewers: readonly string[],
  ): Promise<PrProviderResult<void>>;
  mergePullRequest(input: MergePullRequest): Promise<PrProviderResult<{ mergeSha: string }>>;
}

/** Deterministic in-memory PR provider for unit tests. */
export class InMemoryPrProvider implements PrProviderPort {
  readonly prs = new Map<string, PullRequest>();
  readonly evidence = new Map<string, ReviewEvidence[]>();
  commentsPosted: number = 0;
  requests = 0;
  failNext: { op: 'merge' | 'comment' | 'create'; code: PrProviderErrorCode } | undefined;

  key(repository: GitRepoRef, number: number): string {
    return `${repository.owner}/${repository.repo}#${number}`;
  }

  seedPr(pr: PullRequest): void {
    this.prs.set(this.key(pr.ref, pr.number), pr);
  }

  async getPullRequest(ref: PrRef): Promise<PrProviderResult<PullRequest>> {
    const pr = this.prs.get(this.key(ref, ref.number));
    return pr === undefined
      ? { ok: false, code: 'NOT_FOUND', detail: 'PR not found' }
      : { ok: true, value: pr, fetchedAtIso: new Date().toISOString() };
  }

  async listEvidence(
    ref: PrRef,
    kinds: readonly string[],
    limit: number,
  ): Promise<PrProviderResult<readonly ReviewEvidence[]>> {
    const all = this.evidence.get(this.key(ref, ref.number)) ?? [];
    return {
      ok: true,
      value: all.filter((e) => kinds.includes(e.kind)).slice(0, limit),
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async getCheckEvidence(
    _repository: GitRepoRef,
    _commitSha: string,
    limit: number,
  ): Promise<PrProviderResult<readonly ReviewEvidence[]>> {
    void limit;
    return { ok: true, value: [], fetchedAtIso: new Date().toISOString() };
  }

  async createPullRequest(input: CreatePullRequest): Promise<PrProviderResult<PullRequest>> {
    if (this.failNext?.op === 'create') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected create failure' };
    }
    const number = this.prs.size + 1;
    const pr: PullRequest = {
      providerId: `pr-${number}`,
      ref: { owner: input.repository.owner, repo: input.repository.repo, number },
      number,
      title: input.title,
      body: input.body,
      state: input.draft ? 'open_draft' : 'open_ready',
      draft: input.draft,
      baseRef: input.baseBranch,
      headRef: input.ownedHeadBranch,
      baseSha: input.baseSha,
      headSha: input.headSha,
      authorLogin: 'devguard',
      mergeable: 'unknown',
      updatedAtIso: new Date().toISOString(),
    };
    this.seedPr(pr);
    return { ok: true, value: pr, fetchedAtIso: new Date().toISOString() };
  }

  async updatePullRequest(input: UpdatePullRequest): Promise<PrProviderResult<PullRequest>> {
    const current = this.prs.get(this.key(input.repository, input.prNumber));
    if (current === undefined) return { ok: false, code: 'NOT_FOUND', detail: 'PR not found' };
    if (current.headSha !== input.expectedHeadSha || current.baseSha !== input.expectedBaseSha) {
      return { ok: false, code: 'CONFLICT', detail: 'PR moved' };
    }
    const updated: PullRequest = {
      ...current,
      ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
      ...(input.patch.body !== undefined ? { body: input.patch.body } : {}),
      ...(input.patch.draft !== undefined ? { draft: input.patch.draft } : {}),
      updatedAtIso: new Date().toISOString(),
    };
    this.seedPr(updated);
    return { ok: true, value: updated, fetchedAtIso: new Date().toISOString() };
  }

  async postComment(
    input: PostPullRequestComment,
  ): Promise<PrProviderResult<{ providerId: string }>> {
    void input;
    this.requests += 1;
    if (this.failNext?.op === 'comment') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected comment failure' };
    }
    this.commentsPosted += 1;
    return {
      ok: true,
      value: { providerId: `c-${this.commentsPosted}` },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async requestReview(
    _repository: GitRepoRef,
    _prNumber: number,
    _reviewers: readonly string[],
  ): Promise<PrProviderResult<void>> {
    return { ok: true, value: undefined, fetchedAtIso: new Date().toISOString() };
  }

  async mergePullRequest(input: MergePullRequest): Promise<PrProviderResult<{ mergeSha: string }>> {
    this.requests += 1;
    if (this.failNext?.op === 'merge') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected merge failure' };
    }
    const pr = this.prs.get(this.key(input.repository, input.prNumber));
    if (pr === undefined) return { ok: false, code: 'NOT_FOUND', detail: 'PR not found' };
    if (pr.headSha !== input.expectedHeadSha || pr.baseSha !== input.expectedBaseSha) {
      return { ok: false, code: 'CONFLICT', detail: 'PR moved; merge stale' };
    }
    const merged: PullRequest = {
      ...pr,
      state: 'merged',
      mergedAtIso: new Date().toISOString(),
      mergedByLogin: 'devguard',
      updatedAtIso: new Date().toISOString(),
    };
    this.seedPr(merged);
    return {
      ok: true,
      value: { mergeSha: `${input.expectedHeadSha}` },
      fetchedAtIso: new Date().toISOString(),
    };
  }
}

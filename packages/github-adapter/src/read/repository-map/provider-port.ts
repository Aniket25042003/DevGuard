/**
 * C015 §12/§23 step 3 — narrow normalized content-read port.
 *
 * Provider types stop here. A GitHub-backed implementation maps onto
 * C019/C020 read operations (verified in a later provider-gated step); unit
 * tests use deterministic fakes. Every read is budget-charged by the caller
 * (central budget, C015 §23 step 3) and returns exact-ref-bound data.
 */
import type { CommitRecord, LinkedContextRecord } from './contracts.js';

export type MapProviderErrorCode =
  'NOT_FOUND' | 'PERMISSION' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'SCHEMA_MISMATCH' | 'TIMEOUT';

export type MapProviderResult<T> =
  | { readonly ok: true; readonly value: T; readonly fetchedAtIso: string }
  | { readonly ok: false; readonly code: MapProviderErrorCode; readonly detail: string };

export interface TreeEntryLike {
  readonly path: string;
  readonly kind: 'blob' | 'tree' | 'commit';
  readonly objectSha: string;
  readonly size?: number | undefined;
}

export interface ProviderReadContext {
  readonly correlationId: string;
}

export interface RepositoryContentProviderPort {
  resolveExactRef(input: { ref: string }): Promise<MapProviderResult<{ commitSha: string }>>;
  listTree(input: { commitSha: string }): Promise<
    MapProviderResult<{
      readonly sha: string;
      readonly entries: readonly TreeEntryLike[];
      readonly truncated: boolean;
    }>
  >;
  readFileBytes(input: { commitSha: string; path: string }): Promise<
    MapProviderResult<{
      readonly path: string;
      readonly sizeBytes: number;
      readonly content: string;
    }>
  >;
  readRecentCommits(input: {
    commitSha: string;
    max: number;
  }): Promise<MapProviderResult<readonly CommitRecord[]>>;
  readLinkedContext(input: {
    issueNumber?: number | undefined;
    prNumber?: number | undefined;
  }): Promise<MapProviderResult<readonly LinkedContextRecord[]>>;
}

/**
 * Deterministic in-memory provider for unit tests. Configure the tree, file
 * map, commits and linked context; `failNext`/`rateLimited` exercise
 * provider-outage and rate-limit paths.
 */
export class InMemoryMapProvider implements RepositoryContentProviderPort {
  resolvedSha = 'a'.repeat(40);
  tree: readonly TreeEntryLike[] = [];
  treeTruncated = false;
  files = new Map<string, string>();
  commits: readonly CommitRecord[] = [];
  linkedContext: readonly LinkedContextRecord[] = [];
  rateLimited = false;
  failWith: MapProviderErrorCode | undefined;
  resolveCalls = 0;

  async resolveExactRef(input: { ref: string }): Promise<MapProviderResult<{ commitSha: string }>> {
    void input.ref;
    this.resolveCalls += 1;
    if (this.rateLimited) return { ok: false, code: 'RATE_LIMITED', detail: 'fake rate limit' };
    if (this.failWith !== undefined)
      return { ok: false, code: this.failWith, detail: 'fake failure' };
    return {
      ok: true,
      value: { commitSha: this.resolvedSha },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async listTree(input: { commitSha: string }): Promise<
    MapProviderResult<{
      readonly sha: string;
      readonly entries: readonly TreeEntryLike[];
      readonly truncated: boolean;
    }>
  > {
    void input.commitSha;
    if (this.rateLimited) return { ok: false, code: 'RATE_LIMITED', detail: 'fake rate limit' };
    if (this.failWith !== undefined)
      return { ok: false, code: this.failWith, detail: 'fake failure' };
    return {
      ok: true,
      value: { sha: this.resolvedSha, entries: this.tree, truncated: this.treeTruncated },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readFileBytes(input: { commitSha: string; path: string }): Promise<
    MapProviderResult<{
      readonly path: string;
      readonly sizeBytes: number;
      readonly content: string;
    }>
  > {
    void input.commitSha;
    if (this.rateLimited) return { ok: false, code: 'RATE_LIMITED', detail: 'fake rate limit' };
    if (this.failWith !== undefined)
      return { ok: false, code: this.failWith, detail: 'fake failure' };
    const content = this.files.get(input.path);
    if (content === undefined)
      return { ok: false, code: 'NOT_FOUND', detail: `no file at ${input.path}` };
    return {
      ok: true,
      value: { path: input.path, sizeBytes: Buffer.byteLength(content, 'utf8'), content },
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readRecentCommits(input: {
    commitSha: string;
    max: number;
  }): Promise<MapProviderResult<readonly CommitRecord[]>> {
    void input.commitSha;
    if (this.rateLimited) return { ok: false, code: 'RATE_LIMITED', detail: 'fake rate limit' };
    return {
      ok: true,
      value: this.commits.slice(0, input.max),
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readLinkedContext(input: {
    issueNumber?: number | undefined;
    prNumber?: number | undefined;
  }): Promise<MapProviderResult<readonly LinkedContextRecord[]>> {
    void input.issueNumber;
    void input.prNumber;
    if (this.rateLimited) return { ok: false, code: 'RATE_LIMITED', detail: 'fake rate limit' };
    return { ok: true, value: this.linkedContext, fetchedAtIso: new Date().toISOString() };
  }
}

/**
 * C019 §10/§12 — read-only adapter service.
 *
 * Exposes narrow typed read methods backed by C018 operation descriptors.
 * Consumers never call the transport directly. All outputs are normalized
 * DevGuard types with explicit truncation and binary classification. No
 * write path exists on this port.
 */
import type { SecretString } from '../auth/contracts.js';
import type { GitHubBaseClient } from '../core/client.js';
import type { GitHubRequestContext, GitHubResult } from '../core/contracts.js';
import {
  OP_GET_FILE,
  OP_GET_ISSUE,
  OP_GET_REPOSITORY,
  OP_GET_TREE,
  OP_LIST_ISSUE_COMMENTS,
  OP_RESOLVE_REF,
  type GitHubComment,
  type GitHubIssue,
  type GitHubRepository,
  type GitFile,
  type GitTreePage,
} from './operations.js';

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export interface ReadContext {
  readonly correlationId: string;
  readonly installationId: string;
  readonly deadlineMs?: number | undefined;
  readonly attempt: number;
}

export type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code:
        | 'NOT_FOUND'
        | 'PERMISSION'
        | 'VALIDATION'
        | 'RATE_LIMITED'
        | 'SERVER_ERROR'
        | 'SCHEMA_MISMATCH';
      readonly detail: string;
    };

export class GitHubReadAdapter {
  constructor(private readonly client: GitHubBaseClient) {}

  #requestCtx(operation: { operationId: string }, ctx: ReadContext): GitHubRequestContext {
    return {
      operationId: operation.operationId,
      correlationId: ctx.correlationId,
      installationId: ctx.installationId,
      attempt: ctx.attempt,
      apiVersion: '2022-11-28',
      ...(ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {}),
    };
  }

  async #toReadResult<TOut>(
    result: GitHubResult<unknown>,
    transform: (value: unknown) => TOut,
  ): Promise<ReadResult<TOut>> {
    if (!result.ok) {
      const error = result.error;
      return {
        ok: false,
        code:
          error.kind === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.kind === 'PERMISSION'
              ? 'PERMISSION'
              : error.kind === 'RATE_LIMITED'
                ? 'RATE_LIMITED'
                : error.kind === 'VALIDATION'
                  ? 'VALIDATION'
                  : error.kind === 'SCHEMA_MISMATCH'
                    ? 'SCHEMA_MISMATCH'
                    : 'SERVER_ERROR',
        detail: error.message,
      };
    }
    if ('notModified' in result && result.notModified) {
      return { ok: false, code: 'VALIDATION', detail: '304 without cached previous value' };
    }
    return { ok: true, value: transform(result.value) };
  }

  async getRepository(
    input: { owner: string; repo: string },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<GitHubRepository>> {
    const validated = { owner: input.owner, repo: input.repo };
    const result = await this.client.execute(
      OP_GET_REPOSITORY,
      validated,
      this.#requestCtx(OP_GET_REPOSITORY, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => value)) as ReadResult<GitHubRepository>;
  }

  async getIssue(
    input: { owner: string; repo: string; issueNumber: number },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<GitHubIssue>> {
    const validated = { owner: input.owner, repo: input.repo, issue_number: input.issueNumber };
    const result = await this.client.execute(
      OP_GET_ISSUE,
      validated,
      this.#requestCtx(OP_GET_ISSUE, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => value)) as ReadResult<GitHubIssue>;
  }

  async listIssueComments(
    input: { owner: string; repo: string; issueNumber: number; perPage: number; page: number },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<GitHubComment[]>> {
    const validated = {
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issueNumber,
      per_page: input.perPage,
      page: input.page,
    };
    const result = await this.client.execute(
      OP_LIST_ISSUE_COMMENTS,
      validated,
      this.#requestCtx(OP_LIST_ISSUE_COMMENTS, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => value)) as ReadResult<GitHubComment[]>;
  }

  async resolveRef(
    input: { owner: string; repo: string; ref: string },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<{ commitSha: string }>> {
    const validated = { owner: input.owner, repo: input.repo, ref: input.ref };
    const result = await this.client.execute(
      OP_RESOLVE_REF,
      validated,
      this.#requestCtx(OP_RESOLVE_REF, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => {
      const raw = value as unknown as { object: { sha: string } };
      return { commitSha: raw.object.sha };
    })) as ReadResult<{ commitSha: string }>;
  }

  async listTree(
    input: { owner: string; repo: string; commitSha: string },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<GitTreePage>> {
    const validated = {
      owner: input.owner,
      repo: input.repo,
      commit_sha: input.commitSha,
      recursive: '1',
    };
    const result = await this.client.execute(
      OP_GET_TREE,
      validated,
      this.#requestCtx(OP_GET_TREE, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => {
      const raw = value as unknown as {
        sha: string;
        tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
        truncated: boolean;
      };
      const page: GitTreePage = {
        sha: raw.sha,
        truncated: raw.truncated,
        entries: raw.tree.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          kind: entry.type as 'blob' | 'tree' | 'commit',
          objectSha: entry.sha,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
        })),
      };
      return page;
    })) as ReadResult<GitTreePage>;
  }

  async getFile(
    input: {
      owner: string;
      repo: string;
      commitSha: string;
      path: string;
      maxBytes?: number | undefined;
    },
    ctx: ReadContext,
    token: SecretString,
  ): Promise<ReadResult<GitFile>> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    const validated = {
      owner: input.owner,
      repo: input.repo,
      commit_sha: input.commitSha,
      path: input.path,
    };
    const result = await this.client.execute(
      OP_GET_FILE,
      validated,
      this.#requestCtx(OP_GET_FILE, ctx),
      token,
    );
    return (await this.#toReadResult(result, (value) => {
      const raw = value as unknown as {
        path: string;
        sha: string;
        size: number;
        content: string | null;
        encoding?: string;
      };
      const truncated = raw.size > maxBytes;
      let text: string | undefined;
      let encoding: 'text' | 'binary' = 'text';
      if (!truncated && raw.content && raw.encoding === 'base64') {
        const decoded = Buffer.from(raw.content, 'base64');
        if (decoded.includes(0)) {
          encoding = 'binary';
        } else {
          text = decoded.toString('utf8');
        }
      } else if (!truncated && raw.content) {
        text = raw.content;
      }
      const file: GitFile = {
        path: raw.path,
        ref: input.commitSha,
        blobSha: raw.sha,
        sizeBytes: raw.size,
        encoding,
        ...(text !== undefined ? { text } : {}),
        truncated,
      };
      return file;
    })) as ReadResult<GitFile>;
  }
}

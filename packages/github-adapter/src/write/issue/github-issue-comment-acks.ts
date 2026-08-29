/**
 * CP021 — post GitHub issue/PR thread replies for @devguard command outcomes.
 *
 * Fire-and-forget ack path: installation-scoped token lease + bounded write op.
 * Does not use the C021 PR mutation FSM (no workflow run / operation store).
 */
import type { GitHubCapability } from '../../auth/contracts.js';
import type { TokenLeaseManager } from '../../auth/token-lease-cache.js';
import type { GitHubBaseClient } from '../../core/client.js';
import type { AuthorizedActionContext, GitHubRequestContext } from '../../core/contracts.js';
import { mutationInputDigest, sanitizePrContent } from '../pr/pr-safe.js';
import { OP_CREATE_ISSUE_COMMENT } from './operations.js';

const ACK_CAPABILITIES = ['issue.comment.write'] as const satisfies readonly GitHubCapability[];

export interface PostIssueCommentAckInput {
  readonly correlationId: string;
  readonly installationId: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly triggerCommentId: number;
  readonly body: string;
  readonly attempt?: number | undefined;
}

export type PostIssueCommentAckResult =
  | { readonly ok: true; readonly githubCommentId: number }
  | {
      readonly ok: false;
      readonly code:
        | 'PERMISSION'
        | 'VALIDATION'
        | 'RATE_LIMITED'
        | 'SERVER_ERROR'
        | 'UNAUTHORIZED_WRITE';
      readonly detail: string;
    };

export interface GitHubIssueCommentAckServiceDeps {
  readonly client: GitHubBaseClient;
  readonly tokenLeases: TokenLeaseManager;
  readonly credentialVersion: string;
}

export class GitHubIssueCommentAckService {
  constructor(private readonly deps: GitHubIssueCommentAckServiceDeps) {}

  async postAck(input: PostIssueCommentAckInput): Promise<PostIssueCommentAckResult> {
    let body: string;
    try {
      body = sanitizePrContent(input.body, 64_000);
    } catch (error) {
      return {
        ok: false,
        code: 'VALIDATION',
        detail: error instanceof Error ? error.message : 'ack_body_rejected',
      };
    }

    const digest = mutationInputDigest({
      kind: 'issue_comment_ack',
      triggerCommentId: input.triggerCommentId,
      issueNumber: input.issueNumber,
      repositoryId: input.githubRepositoryId,
      body,
    });
    const authorized: AuthorizedActionContext = {
      decisionId: 'system-github-comment-ack',
      operationKey: OP_CREATE_ISSUE_COMMENT.operationId,
      actionFingerprint: digest,
      digest,
    };
    const requestCtx: GitHubRequestContext = {
      operationId: OP_CREATE_ISSUE_COMMENT.operationId,
      correlationId: input.correlationId,
      installationId: input.installationId,
      repositoryScope: input.githubRepositoryId,
      attempt: input.attempt ?? 1,
      apiVersion: '2022-11-28',
      authorizationContext: { digest },
    };

    const lease = await this.deps.tokenLeases.acquire(
      `ack:${input.triggerCommentId}`,
      input.installationId,
      [input.githubRepositoryId],
      ACK_CAPABILITIES,
      this.deps.credentialVersion,
    );

    const result = await this.deps.client.execute(
      OP_CREATE_ISSUE_COMMENT,
      {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body,
      },
      requestCtx,
      lease.token,
      authorized,
    );

    if (!result.ok) {
      const kind = result.error.kind;
      return {
        ok: false,
        code:
          kind === 'PERMISSION' || kind === 'AUTHENTICATION'
            ? 'PERMISSION'
            : kind === 'VALIDATION'
              ? 'VALIDATION'
              : kind === 'RATE_LIMITED'
                ? 'RATE_LIMITED'
                : kind === 'UNAUTHORIZED_WRITE'
                  ? 'UNAUTHORIZED_WRITE'
                  : 'SERVER_ERROR',
        detail: result.error.message,
      };
    }
    if ('notModified' in result && result.notModified) {
      return { ok: false, code: 'SERVER_ERROR', detail: 'unexpected 304 on create comment' };
    }
    return { ok: true, githubCommentId: result.value.githubCommentId };
  }
}

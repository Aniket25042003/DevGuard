/**
 * CP021 — lightweight issue-comment write operation (webhook ack replies).
 */
import { z } from 'zod';
import type { GitHubOperation } from '../../core/contracts.js';
import { issueNumber } from '../../read/operations.js';

const outputCreatedComment = z
  .object({
    id: z.number().int().positive(),
    body: z.string(),
  })
  .transform((raw) => ({
    githubCommentId: raw.id,
    body: raw.body,
  }));

export interface CreatedIssueComment {
  readonly githubCommentId: number;
  readonly body: string;
}

export const OP_CREATE_ISSUE_COMMENT: GitHubOperation<
  { owner: string; repo: string; issue_number: number; body: string },
  CreatedIssueComment
> = {
  operationId: 'github.create-issue-comment',
  method: 'POST',
  safety: 'write',
  pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    issue_number: issueNumber,
    body: z.string().min(1).max(256_000),
  }),
  outputSchema: outputCreatedComment as never,
  successStatuses: [201],
  supportsConditional: false,
  paginationStyle: 'none',
  retrySafe: false,
};

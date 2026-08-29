/**
 * CP019 — CommentCommandService: webhook `issue_comment` → CommandBus.submit.
 * Parser + identity + authorization live here; adapters stay HTTP-only.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowIdV1 } from '@devguard/policy-engine';
import type { CommandBus } from './command-bus.js';
import {
  githubCommentIdempotencyKey,
  parseDevguardComment,
  type ParsedGitHubComment,
} from './github-comment-parser.js';
import {
  issueCommentIsOnPullRequest,
  type IssueCommentWebhookEvent,
} from './issue-comment-event.js';

export const GITHUB_ISSUER = 'https://github.com';

export type CommentCommandOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'meta'; readonly verb: 'help' | 'status' }
  | { readonly kind: 'denied'; readonly code: string; readonly detail: string }
  | {
      readonly kind: 'submitted';
      readonly runId: string;
      readonly replayed: boolean;
      readonly commandId: WorkflowIdV1;
    };

export interface CommentIdentityPort {
  resolveOrCreateUser(input: {
    readonly issuer: string;
    readonly subject: string;
    readonly login: string;
  }): Promise<string>;
}

export interface CommentRepositoryPort {
  findByGitHubRepositoryId(githubRepositoryId: string): Promise<
    | {
        readonly id: string;
        readonly status: string;
      }
    | undefined
  >;
}

export interface CommentAckPort {
  postAck(input: {
    readonly event: IssueCommentWebhookEvent;
    readonly message: string;
  }): Promise<void>;
}

export interface CommentAuthorizerPort {
  authorizeWorkflowStart(input: {
    readonly userId: string;
    readonly issuer: string;
    readonly providerSubject: string;
    readonly repositoryId: string;
  }): Promise<{ readonly allowed: boolean; readonly reasonCode?: string | undefined }>;
}

export interface CommentCommandServiceDeps {
  readonly commandBus: CommandBus;
  readonly identities: CommentIdentityPort;
  readonly repositories: CommentRepositoryPort;
  readonly authorizer: CommentAuthorizerPort;
  readonly acks?: CommentAckPort | undefined;
  readonly mentionLogin?: string | undefined;
  readonly acksEnabled?: boolean | undefined;
}

export class CommentCommandService {
  constructor(private readonly deps: CommentCommandServiceDeps) {}

  async handle(event: IssueCommentWebhookEvent): Promise<CommentCommandOutcome> {
    const parsed = parseDevguardComment(event.comment.body, {
      authorLogin: event.comment.user.login,
      ...(this.deps.mentionLogin !== undefined ? { mentionLogin: this.deps.mentionLogin } : {}),
    });
    if (parsed.kind === 'ignored') return { kind: 'ignored' };
    if (parsed.kind === 'denied') {
      await this.maybeAck(event, parsed);
      return { kind: 'denied', code: parsed.code, detail: parsed.detail };
    }
    if (parsed.kind === 'meta') {
      await this.maybeAck(event, parsed);
      return { kind: 'meta', verb: parsed.verb };
    }
    return this.submitCommand(event, parsed);
  }

  private async submitCommand(
    event: IssueCommentWebhookEvent,
    parsed: Extract<ParsedGitHubComment, { kind: 'command' }>,
  ): Promise<CommentCommandOutcome> {
    const repo = await this.deps.repositories.findByGitHubRepositoryId(String(event.repository.id));
    if (repo === undefined || repo.status !== 'active') {
      const denied = {
        kind: 'denied' as const,
        code: 'REPOSITORY_UNKNOWN',
        detail: 'Repository is not connected to DevGuard.',
      };
      await this.maybeAck(event, denied);
      return denied;
    }

    const userId = await this.deps.identities.resolveOrCreateUser({
      issuer: GITHUB_ISSUER,
      subject: String(event.comment.user.id),
      login: event.comment.user.login,
    });

    const authz = await this.deps.authorizer.authorizeWorkflowStart({
      userId,
      issuer: GITHUB_ISSUER,
      providerSubject: String(event.comment.user.id),
      repositoryId: repo.id,
    });
    if (!authz.allowed) {
      const denied = {
        kind: 'denied' as const,
        code: authz.reasonCode ?? 'FORBIDDEN',
        detail: 'You do not have permission to start workflows on this repository.',
      };
      await this.maybeAck(event, denied);
      return denied;
    }

    const input = enrichInput(parsed.commandId, parsed.input, event);
    const idempotencyKey = githubCommentIdempotencyKey(event.comment.id, parsed.commandId);
    try {
      const receipt = await this.deps.commandBus.submit({
        command: {
          commandId: parsed.commandId,
          definitionVersion: '1',
          input,
        },
        repositoryId: repo.id,
        originSurface: 'github_comment',
        idempotencyKey,
        createdBy: userId,
        trustedSurface: true,
      });
      const submitted = {
        kind: 'submitted' as const,
        runId: receipt.runId,
        replayed: receipt.replayed,
        commandId: parsed.commandId,
      };
      await this.maybeAck(event, submitted);
      return submitted;
    } catch (error) {
      // Unexpected submission failures must remain retryable for the worker to redeliver.
      throw error;
    }
  }

  private async maybeAck(
    event: IssueCommentWebhookEvent,
    outcome:
      | Extract<ParsedGitHubComment, { kind: 'denied' | 'meta' }>
      | { readonly kind: 'denied'; readonly code: string; readonly detail: string }
      | { readonly kind: 'submitted'; readonly runId: string; readonly replayed: boolean },
  ): Promise<void> {
    if (this.deps.acksEnabled === false || this.deps.acks === undefined) return;
    const message = formatAck(outcome);
    if (message === undefined) return;
    await this.deps.acks.postAck({ event, message });
  }
}

function enrichInput(
  commandId: WorkflowIdV1,
  input: Record<string, unknown>,
  event: IssueCommentWebhookEvent,
): Record<string, unknown> {
  const next = { ...input };
  if (
    (commandId === 'review_remediation' || commandId === 'diagnose_failure') &&
    next['pullRequestNumber'] === undefined &&
    issueCommentIsOnPullRequest(event)
  ) {
    next['pullRequestNumber'] = event.issue.number;
  }
  if (commandId === 'implement_issue' && next['issueNumber'] === undefined) {
    next['issueNumber'] = event.issue.number;
  }
  if (parsedNotes(event).length > 0) {
    next['notes'] = parsedNotes(event);
  }
  return next;
}

function parsedNotes(event: IssueCommentWebhookEvent): string {
  const lines = event.comment.body.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return '';
  return lines
    .slice(first + 1)
    .join('\n')
    .trim();
}

function formatAck(
  outcome:
    | Extract<ParsedGitHubComment, { kind: 'denied' | 'meta' }>
    | { readonly kind: 'denied'; readonly code: string; readonly detail: string }
    | { readonly kind: 'submitted'; readonly runId: string; readonly replayed: boolean },
): string | undefined {
  if (outcome.kind === 'meta') {
    return outcome.verb === 'help'
      ? 'DevGuard commands: review, fix, audit, patch, implement, status, help.'
      : 'Use `@devguard status` on a run in the DevGuard UI for live workflow state.';
  }
  if (outcome.kind === 'denied') {
    if (outcome.code === 'BOT_SELF') return undefined;
    if (outcome.code === 'COMMAND_UNKNOWN') {
      return `Unknown command. Reply with \`@devguard help\` for the verb list. (${outcome.detail})`;
    }
    return `Could not start a workflow: ${outcome.detail}`;
  }
  if (outcome.replayed) {
    return `This comment already started run \`${outcome.runId}\`.`;
  }
  return `Queued workflow run \`${outcome.runId}\` (origin GitHub comment).`;
}

/** Create a DevGuard user id for first-time GitHub commenters (CP019 §17). */
export function newGitHubActorUserId(): string {
  return randomUUID();
}

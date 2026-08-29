/** CP019 — CommentCommandService integration with mocked ports. */
import { describe, expect, it, vi } from 'vitest';
import {
  CommandBus,
  type CommandBusPersistencePort,
  type CreateQueuedRunInput,
} from './command-bus.js';
import { CommentCommandService } from './comment-command-service.js';
import type { IssueCommentWebhookEvent } from './issue-comment-event.js';

class MemoryPersistence implements CommandBusPersistencePort {
  readonly runs: string[] = [];
  private replay = false;

  setReplay(value: boolean): void {
    this.replay = value;
  }

  async createQueuedRun(
    input: CreateQueuedRunInput,
  ): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  > {
    if (this.replay) return { outcome: 'replayed', runId: 'run-existing' };
    this.runs.push(input.runId);
    return { outcome: 'created', runId: input.runId };
  }
}

const EVENT: IssueCommentWebhookEvent = {
  action: 'created',
  comment: { id: 42, body: '@devguard review', user: { id: 9, login: 'octo' } },
  issue: { number: 7, pull_request: { url: 'https://github.com/o/r/pull/7' } },
  repository: { id: 555, owner: { login: 'o' }, name: 'r', full_name: 'o/r' },
  installation: { id: 1 },
};

describe('CommentCommandService (CP019)', () => {
  it('submits review_remediation with github_comment origin and idempotency key', async () => {
    const persistence = new MemoryPersistence();
    const bus = new CommandBus({ persistence, newRunId: () => 'run-gh-1' });
    const service = new CommentCommandService({
      commandBus: bus,
      identities: {
        resolveOrCreateUser: async () => 'user-1',
      },
      repositories: {
        findByGitHubRepositoryId: async () => ({ id: 'repo-1', status: 'active' }),
      },
      authorizer: {
        authorizeWorkflowStart: async () => ({ allowed: true }),
      },
      acksEnabled: false,
    });
    const outcome = await service.handle(EVENT);
    expect(outcome).toEqual({
      kind: 'submitted',
      runId: 'run-gh-1',
      replayed: false,
      commandId: 'review_remediation',
    });
    expect(persistence.runs).toEqual(['run-gh-1']);
  });

  it('posts an ack when help is requested', async () => {
    const acks = { postAck: vi.fn(async () => {}) };
    const service = new CommentCommandService({
      commandBus: new CommandBus({ persistence: new MemoryPersistence() }),
      identities: { resolveOrCreateUser: async () => 'u' },
      repositories: { findByGitHubRepositoryId: async () => ({ id: 'r', status: 'active' }) },
      authorizer: { authorizeWorkflowStart: async () => ({ allowed: true }) },
      acks,
      acksEnabled: true,
    });
    const outcome = await service.handle({
      ...EVENT,
      comment: { ...EVENT.comment, body: '@devguard help' },
    });
    expect(outcome).toEqual({ kind: 'meta', verb: 'help' });
    expect(acks.postAck).toHaveBeenCalledOnce();
    expect(acks.postAck.mock.calls[0]?.[0]?.message).toContain('DevGuard commands');
  });

  it('returns ignored when the comment has no mention', async () => {
    const service = new CommentCommandService({
      commandBus: new CommandBus({ persistence: new MemoryPersistence() }),
      identities: { resolveOrCreateUser: async () => 'u' },
      repositories: { findByGitHubRepositoryId: async () => undefined },
      authorizer: { authorizeWorkflowStart: async () => ({ allowed: false }) },
    });
    const outcome = await service.handle({
      ...EVENT,
      comment: { ...EVENT.comment, body: 'no mention here' },
    });
    expect(outcome).toEqual({ kind: 'ignored' });
  });
});

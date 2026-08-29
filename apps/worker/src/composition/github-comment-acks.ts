/**
 * CP021 — worker wiring: GitHub issue-comment ack replies after command handling.
 */
import { createHash } from 'node:crypto';
import type { GithubAppConfig } from '@devguard/config';
import {
  AppJwtSigner,
  FetchInstallationTokenMintPort,
  FetchTransport,
  GitHubBaseClient,
  GitHubIssueCommentAckService,
  InMemoryKeyProvider,
  InMemoryTokenLeaseCache,
  TokenLeaseManager,
} from '@devguard/github-adapter';
import type { DevGuardPool } from '@devguard/db';
import { InMemoryCommentAckDedupStore, PostgresCommentAckDedupStore } from '@devguard/db';
import type { CommentAckPort } from '@devguard/workflows';
import type { IssueCommentWebhookEvent } from '@devguard/workflows';

export interface CommentAckDedupPort {
  tryClaim(githubCommentId: number, ackDigest: string): Promise<boolean>;
  markApplied(githubCommentId: number, ackDigest: string): Promise<void>;
}

function ackDigest(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

export class WorkerGitHubCommentAckAdapter implements CommentAckPort {
  constructor(
    private readonly acks: GitHubIssueCommentAckService,
    private readonly dedup: CommentAckDedupPort,
  ) {}

  async postAck(input: {
    readonly event: IssueCommentWebhookEvent;
    readonly message: string;
  }): Promise<void> {
    const { event, message } = input;
    const installationId = event.installation?.id;
    if (installationId === undefined) {
      throw new Error('github_comment_ack_missing_installation');
    }
    const digest = ackDigest(message);
    const claimed = await this.dedup.tryClaim(event.comment.id, digest);
    if (!claimed) return;

    const result = await this.acks.postAck({
      correlationId: `comment-ack:${event.comment.id}`,
      installationId: String(installationId),
      githubRepositoryId: String(event.repository.id),
      owner: event.repository.owner.login,
      repo: event.repository.name,
      issueNumber: event.issue.number,
      triggerCommentId: event.comment.id,
      body: message,
    });
    if (!result.ok) {
      throw new Error(`github_comment_ack_failed:${result.code}:${result.detail}`);
      }
      await this.dedup.markApplied(event.comment.id, digest);
    }
  }
}

export function buildGitHubCommentAckAdapter(
  github: GithubAppConfig,
  privateKeyPem: string,
  pool: DevGuardPool | undefined,
): CommentAckPort {
  const transport = new FetchTransport();
  const signer = new AppJwtSigner({ nowMs: () => Date.now() });
  const keyProvider = new InMemoryKeyProvider({
    privateKeyPem,
    keyVersion: 'v1',
    appId: github.appId,
  });
  const tokenLeases = new TokenLeaseManager(
    new InMemoryTokenLeaseCache(),
    new FetchInstallationTokenMintPort({ transport, signer, keyProvider }),
    () => Date.now(),
  );
  const client = new GitHubBaseClient({ transport, apiVersion: '2022-11-28' });
  const acks = new GitHubIssueCommentAckService({
    client,
    tokenLeases,
    credentialVersion: github.privateKeyRef,
  });
  const dedup =
    pool !== undefined ? new PostgresCommentAckDedupStore(pool) : new InMemoryCommentAckDedupStore();
  return new WorkerGitHubCommentAckAdapter(acks, dedup);
}

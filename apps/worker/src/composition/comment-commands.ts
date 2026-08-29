/**
 * CP019/CP021 — worker-side wiring for GitHub comment commands + ack replies.
 */
import type { WorkerConfigSnapshot } from '@devguard/config';
import {
  ConnectedRepositoryStore,
  IdentityRepository,
  PostgresLocalRepositoryAccessPort,
  type DevGuardPool,
} from '@devguard/db';
import { RepositoryAuthorizationService, type GitHubPermissionPort } from '@devguard/authorization';
import {
  CommentCommandService,
  CommandBus,
  newGitHubActorUserId,
  type CommentAckPort,
} from '@devguard/workflows';
import { WorkerCommandBusPersistencePort } from './command-bus-persistence.js';
import { repositoryAuthorizerAdapter } from './comment-authorizer.js';
import { buildGitHubCommentAckAdapter } from './github-comment-acks.js';
import { EmptyLocalRepositoryAccessPort } from './stubs.js';

function isReal(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && !value.startsWith('<');
}

export function buildCommentCommandService(
  pool: DevGuardPool,
  authorizer: RepositoryAuthorizationService,
  config: WorkerConfigSnapshot,
): CommentCommandService {
  const identities = new IdentityRepository(pool);
  const repos = new ConnectedRepositoryStore(pool);
  const commandBus = new CommandBus({ persistence: new WorkerCommandBusPersistencePort(pool) });
  const acksEnabled = process.env['DEVGUARD_GITHUB_COMMENT_ACKS'] !== 'false';
  let acks: CommentAckPort | undefined;
  const privateKeyPem =
    config.github !== undefined && isReal(config.github.privateKeyRef)
      ? config.github.privateKeyRef
      : undefined;
  if (acksEnabled && config.github !== undefined && privateKeyPem !== undefined) {
    acks = buildGitHubCommentAckAdapter(config.github, privateKeyPem, pool);
  }
  return new CommentCommandService({
    commandBus,
    identities: {
      resolveOrCreateUser: async ({ issuer, subject, login }) => {
        const existing = await identities.findByExternalSubject(issuer, subject);
        if (existing !== null) return existing.userId;
        const userId = newGitHubActorUserId();
        await identities.upsertObservedIdentity({
          userId,
          issuer,
          subject,
          loginSnapshot: login,
        });
        return userId;
      },
    },
    repositories: {
      findByGitHubRepositoryId: async (githubRepositoryId) => {
        const row = await repos.findByGitHubId(githubRepositoryId);
        return row === null ? undefined : { id: row.id, status: row.status };
      },
    },
    authorizer: repositoryAuthorizerAdapter(authorizer),
    ...(acks !== undefined ? { acks } : {}),
    acksEnabled,
  });
}

export function buildWorkerAuthorizer(
  pool: DevGuardPool | undefined,
  github: GitHubPermissionPort,
): RepositoryAuthorizationService {
  return new RepositoryAuthorizationService({
    local:
      pool !== undefined
        ? new PostgresLocalRepositoryAccessPort(pool)
        : new EmptyLocalRepositoryAccessPort(),
    github,
    evidence: {
      async append() {},
      async findFresh() {
        return undefined;
      },
    },
    readCacheTtlSeconds: 0,
    now: () => new Date(),
  });
}

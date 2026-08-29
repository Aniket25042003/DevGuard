/**
 * CP019 — worker-side wiring for GitHub comment commands.
 */
import {
  ConnectedRepositoryStore,
  IdentityRepository,
  PostgresLocalRepositoryAccessPort,
  type DevGuardPool,
} from '@devguard/db';
import { RepositoryAuthorizationService } from '@devguard/authorization';
import { CommentCommandService, CommandBus, newGitHubActorUserId } from '@devguard/workflows';
import { WorkerCommandBusPersistencePort } from './command-bus-persistence.js';
import { repositoryAuthorizerAdapter } from './comment-authorizer.js';
import { EmptyLocalRepositoryAccessPort, UnavailableGitHubPermissionPort } from './stubs.js';

export function buildCommentCommandService(
  pool: DevGuardPool,
  authorizer: RepositoryAuthorizationService,
): CommentCommandService {
  const identities = new IdentityRepository(pool);
  const repos = new ConnectedRepositoryStore(pool);
  const commandBus = new CommandBus({ persistence: new WorkerCommandBusPersistencePort(pool) });
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
    acksEnabled: process.env['DEVGUARD_GITHUB_COMMENT_ACKS'] !== 'false',
  });
}

export function buildWorkerAuthorizer(
  pool: DevGuardPool | undefined,
): RepositoryAuthorizationService {
  return new RepositoryAuthorizationService({
    local:
      pool !== undefined
        ? new PostgresLocalRepositoryAccessPort(pool)
        : new EmptyLocalRepositoryAccessPort(),
    github: new UnavailableGitHubPermissionPort(),
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

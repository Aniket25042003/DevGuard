/**
 * C013 §22 — repository lifecycle connect/reconnect/block paths.
 */
import { describe, expect, it } from 'vitest';
import {
  RepositoryLifecycleService,
  type ConnectedRepositoryRecord,
  type RepositoryLifecyclePersistencePort,
} from './lifecycle.js';

const baseRecord = (overrides: Partial<ConnectedRepositoryRecord> = {}): ConnectedRepositoryRecord => ({
  id: 'rec-1',
  repositoryDevguardId: 'repo-1',
  githubRepositoryId: 42,
  installationId: 'inst-1',
  ownerLogin: 'octo',
  repoName: 'demo',
  fullName: 'octo/demo',
  defaultBranch: 'main',
  visibility: 'private',
  status: 'connected',
  policyVersionId: 'pv-1',
  connectedAtIso: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function makeService(
  persistence: Partial<RepositoryLifecyclePersistencePort>,
  installationActive = true,
  permissions: readonly string[] = ['contents: read', 'issues: read', 'metadata: read'],
): RepositoryLifecycleService {
  return new RepositoryLifecycleService(
    {
      findByGithubRepositoryId: async () => undefined,
      findByInstallationId: async () => [],
      insertConnected: async () => baseRecord(),
      onboardRepository: async (input) =>
        baseRecord({
          githubRepositoryId: input.githubRepositoryId,
          installationId: input.installationId,
          ownerLogin: input.ownerLogin,
          repoName: input.repoName,
          policyVersionId: (await input.seedPolicy('repo-new')).policyVersionId,
        }),
      updateStatus: async (input) =>
        baseRecord({
          repositoryDevguardId: input.repositoryDevguardId,
          status: input.status,
          ...(input.degradedReasonCode !== undefined
            ? { degradedReasonCode: input.degradedReasonCode }
            : {}),
        }),
      delete: async () => {},
      ...persistence,
    },
    {
      seedDefaultPolicy: async () => ({ policyVersionId: 'pv-default' }),
    },
    {
      verifyInstallation: async () => ({
        active: installationActive,
        accountLogin: 'octo',
        permissions,
      }),
    },
  );
}

describe('RepositoryLifecycleService (C013)', () => {
  it('connects a new repository when installation permissions are sufficient', async () => {
    let onboarded = false;
    const service = makeService({
      onboardRepository: async (input) => {
        onboarded = true;
        return baseRecord({
          repositoryDevguardId: 'repo-new',
          githubRepositoryId: input.githubRepositoryId,
        });
      },
    });
    const result = await service.connect({
      actorId: 'user-1',
      installationId: 'inst-1',
      githubRepositoryId: 99,
      idempotencyKey: 'k1',
      ownerLogin: 'octo',
      repoName: 'new',
      defaultBranch: 'main',
      visibility: 'private',
    });
    expect(onboarded).toBe(true);
    expect(result.outcome).toBe('CONNECTED');
  });

  it('reconnects a previously disconnected repository idempotently', async () => {
    const service = makeService({
      findByGithubRepositoryId: async () => baseRecord({ status: 'disconnected' }),
    });
    const result = await service.connect({
      actorId: 'user-1',
      installationId: 'inst-1',
      githubRepositoryId: 42,
      idempotencyKey: 'k1',
      ownerLogin: 'octo',
      repoName: 'demo',
      defaultBranch: 'main',
      visibility: 'private',
    });
    expect(result.outcome).toBe('RECONNECTED');
    if (result.outcome === 'RECONNECTED') {
      expect(result.record.status).toBe('connected');
    }
  });

  it('blocks connect when required installation permissions are missing', async () => {
    const service = makeService({}, true, ['metadata: read']);
    const result = await service.connect({
      actorId: 'user-1',
      installationId: 'inst-1',
      githubRepositoryId: 42,
      idempotencyKey: 'k1',
      ownerLogin: 'octo',
      repoName: 'demo',
      defaultBranch: 'main',
      visibility: 'private',
    });
    expect(result).toEqual({
      outcome: 'BLOCKED',
      code: 'MISSING_PERMISSIONS',
      detail: expect.stringContaining('contents: read'),
    });
  });

  it('allows connect when GitHub granted write permissions on required scopes', async () => {
    const service = makeService(
      {
        onboardRepository: async (input) =>
          baseRecord({
            githubRepositoryId: input.githubRepositoryId,
            installationId: input.installationId,
            ownerLogin: input.ownerLogin,
            repoName: input.repoName,
          }),
      },
      true,
      ['contents: write', 'issues: write', 'metadata: read'],
    );
    const result = await service.connect({
      actorId: 'user-1',
      installationId: 'inst-1',
      githubRepositoryId: 42,
      idempotencyKey: 'k1',
      ownerLogin: 'octo',
      repoName: 'demo',
      defaultBranch: 'main',
      visibility: 'private',
    });
    expect(result.outcome).toBe('CONNECTED');
  });
});

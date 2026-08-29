/**
 * C017 — collaborator permission normalization.
 */
import { describe, expect, it } from 'vitest';
import { GitHubCollaboratorRoleService, secretFrom } from '@devguard/github-adapter';

describe('GitHubCollaboratorRoleService (C017)', () => {
  it('normalizes collaborator permission responses', async () => {
    const service = new GitHubCollaboratorRoleService({
      request: async () => ({
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ permission: 'write' }),
      }),
    });
    const result = await service.fetchRole({
      token: secretFrom('ghs_test'),
      owner: 'octo',
      repo: 'demo',
      userLogin: 'dev',
    });
    expect(result.role).toBe('write');
    expect(result.snapshotHash).toHaveLength(64);
  });

  it('returns none for missing collaborators without throwing', async () => {
    const service = new GitHubCollaboratorRoleService({
      request: async () => ({ status: 404, headers: {}, bodyText: '' }),
    });
    const result = await service.fetchRole({
      token: secretFrom('ghs_test'),
      owner: 'octo',
      repo: 'demo',
      userLogin: 'unknown',
    });
    expect(result.role).toBe('none');
  });

  it('treats personal-account owners as admin when collaborator lookup is missing', async () => {
    const service = new GitHubCollaboratorRoleService({
      request: async () => ({ status: 404, headers: {}, bodyText: '' }),
    });
    const result = await service.fetchRole({
      token: secretFrom('ghs_test'),
      owner: 'octo',
      repo: 'demo',
      userLogin: 'octo',
    });
    expect(result.role).toBe('admin');
  });
});

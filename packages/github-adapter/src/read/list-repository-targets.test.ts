/**
 * List repository launch targets from GitHub REST responses.
 */
import { describe, expect, it } from 'vitest';
import {
  listRepositoryIssues,
  listRepositoryPullRequests,
  listRepositoryRefs,
} from './list-repository-targets.js';
import { secretFrom } from '../auth/contracts.js';

describe('list-repository-targets', () => {
  it('parses pull requests', async () => {
    const rows = await listRepositoryPullRequests({
      transport: {
        request: async () => ({
          status: 200,
          headers: {},
          bodyText: JSON.stringify([
            {
              number: 12,
              title: 'Fix auth',
              state: 'open',
              user: { login: 'dev' },
              updated_at: '2026-01-01T00:00:00Z',
              html_url: 'https://github.com/o/r/pull/12',
              head: { ref: 'fix-auth' },
              base: { ref: 'main' },
              draft: false,
            },
          ]),
        }),
      },
      token: secretFrom('token'),
      owner: 'octo',
      repo: 'demo',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: 12,
      title: 'Fix auth',
      headRef: 'fix-auth',
      baseRef: 'main',
    });
  });

  it('filters pull requests out of issues', async () => {
    const rows = await listRepositoryIssues({
      transport: {
        request: async () => ({
          status: 200,
          headers: {},
          bodyText: JSON.stringify([
            {
              number: 3,
              title: 'Bug',
              state: 'open',
              user: { login: 'dev' },
              updated_at: '2026-01-01T00:00:00Z',
              html_url: 'https://github.com/o/r/issues/3',
              labels: [{ name: 'bug' }],
            },
            {
              number: 4,
              title: 'PR disguised',
              state: 'open',
              user: { login: 'dev' },
              updated_at: '2026-01-01T00:00:00Z',
              html_url: 'https://github.com/o/r/pull/4',
              pull_request: {},
              labels: [],
            },
          ]),
        }),
      },
      token: secretFrom('token'),
      owner: 'octo',
      repo: 'demo',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe(3);
  });

  it('sorts default branch first for refs', async () => {
    const rows = await listRepositoryRefs({
      transport: {
        request: async () => ({
          status: 200,
          headers: {},
          bodyText: JSON.stringify([
            { name: 'feature', commit: { sha: 'abc1234567890abcdef1234567890abcdef1234' } },
            { name: 'main', commit: { sha: 'def1234567890abcdef1234567890abcdef1234' }, protected: true },
          ]),
        }),
      },
      token: secretFrom('token'),
      owner: 'octo',
      repo: 'demo',
      defaultBranch: 'main',
    });
    expect(rows[0]?.name).toBe('main');
    expect(rows[0]?.isDefault).toBe(true);
  });
});

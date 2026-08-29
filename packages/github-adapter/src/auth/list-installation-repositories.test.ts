import { describe, expect, it } from 'vitest';
import { parseRepositoryCandidates } from './list-installation-repositories.js';

describe('parseRepositoryCandidates', () => {
  it('returns an empty list when repositories are missing', () => {
    expect(parseRepositoryCandidates(undefined)).toEqual([]);
  });

  it('parses GitHub repository payloads', () => {
    expect(
      parseRepositoryCandidates([
        {
          id: 123,
          name: 'DevGuard',
          full_name: 'Aniket25042003/DevGuard',
          owner: { login: 'Aniket25042003' },
          default_branch: 'main',
          private: true,
          archived: false,
        },
      ]),
    ).toEqual([
      {
        githubRepositoryId: '123',
        ownerLogin: 'Aniket25042003',
        repoName: 'DevGuard',
        fullName: 'Aniket25042003/DevGuard',
        defaultBranch: 'main',
        visibility: 'private',
        archived: false,
      },
    ]);
  });
});

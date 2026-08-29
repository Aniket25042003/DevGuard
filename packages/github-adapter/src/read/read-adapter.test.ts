/**
 * C019 §22 — read adapter normalization and error mapping.
 */
import { describe, expect, it } from 'vitest';
import { GitHubBaseClient, GitHubReadAdapter, secretFrom, type RawTransportResponse } from '@devguard/github-adapter';

function transportReturning(response: Partial<RawTransportResponse>) {
  return {
    request: async () =>
      ({
        status: 200,
        headers: { 'x-github-request-id': 'gh-req-1' },
        bodyText: JSON.stringify({
          id: 1,
          number: 7,
          title: 'hello',
          body: '',
          state: 'open',
          labels: [],
          user: { login: 'octo' },
          comments: 0,
        }),
        ...response,
      }) as RawTransportResponse,
  };
}

describe('GitHubReadAdapter (C019)', () => {
  it('maps a successful issue read to normalized output', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({}),
      apiVersion: '2022-11-28',
      nowMs: () => 1_700_000_000_000,
    });
    const adapter = new GitHubReadAdapter(client);
    const result = await adapter.getIssue(
      { owner: 'octo', repo: 'demo', issueNumber: 7 },
      { correlationId: 'c1', installationId: 'inst-1', attempt: 1 },
      secretFrom('ghs_test'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ number: 7, title: 'hello' });
    }
  });

  it('maps provider NOT_FOUND to explicit read failure code', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({
        status: 404,
        bodyText: JSON.stringify({ message: 'Not Found' }),
      }),
      apiVersion: '2022-11-28',
      nowMs: () => 1_700_000_000_000,
    });
    const adapter = new GitHubReadAdapter(client);
    const result = await adapter.getIssue(
      { owner: 'octo', repo: 'demo', issueNumber: 404 },
      { correlationId: 'c1', installationId: 'inst-1', attempt: 1 },
      secretFrom('ghs_test'),
    );
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', detail: expect.any(String) });
  });
});

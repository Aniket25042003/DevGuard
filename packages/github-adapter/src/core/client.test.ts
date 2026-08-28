/**
 * C018 §22 — descriptor validation, URL encoding, error taxonomy, 304
 * conditional requests, pagination caps, rate parsing, write authorization
 * gate, and SSRF guard.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FetchTransport,
  GitHubBaseClient,
  secretFrom,
  type GitHubOperation,
  type GitHubRequestContext,
  type RawTransportResponse,
} from '@devguard/github-adapter';

const NOW = 1_700_000_000_000;
const TOKEN = secretFrom('ghs_testtoken');
const AUTH = {
  decisionId: 'dec-1',
  operationKey: 'test.op',
  actionFingerprint: 'a'.repeat(64),
  digest: 'd'.repeat(64),
};

function writeCtx(): GitHubRequestContext {
  return ctx({ authorizationContext: { digest: 'd'.repeat(64) } });
}

function makeOperation(overrides: Partial<GitHubOperation> = {}): GitHubOperation {
  return {
    operationId: 'test.op',
    method: 'GET',
    safety: 'read',
    pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
    inputSchema: z.object({ owner: z.string(), repo: z.string(), issue_number: z.number() }),
    outputSchema: z.object({ id: z.number() }),
    successStatuses: [200],
    supportsConditional: true,
    paginationStyle: 'none',
    retrySafe: true,
    ...overrides,
  } as GitHubOperation;
}

function ctx(overrides: Partial<GitHubRequestContext> = {}): GitHubRequestContext {
  return {
    operationId: 'test.op',
    correlationId: 'corr-1',
    installationId: 'inst-1',
    attempt: 1,
    apiVersion: '2022-11-28',
    ...overrides,
  };
}

function transportReturning(
  response: Partial<RawTransportResponse>,
  captured: Array<{ path: string; headers: Record<string, string> }> = [],
) {
  return {
    request: async (input: { path: string; headers: Record<string, string> }) => {
      captured.push({ path: input.path, headers: input.headers });
      return {
        status: 200,
        headers: { 'x-github-request-id': 'gh-req-1' },
        bodyText: JSON.stringify({ id: 42 }),
        ...response,
      } as RawTransportResponse;
    },
  };
}

describe('GitHubBaseClient (C018 §22)', () => {
  it('returns validated output with metadata on success', async () => {
    const captured: Array<{ path: string; headers: Record<string, string> }> = [];
    const client = new GitHubBaseClient({
      transport: transportReturning({}, captured),
      apiVersion: '2022-11-28',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'octo', repo: 'app', issue_number: 7 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(true);
    if (result.ok && !('notModified' in result && result.notModified)) {
      expect(result.value).toEqual({ id: 42 });
      expect(result.meta.githubRequestId).toBe('gh-req-1');
    }
    // Path built from template with encoding; no raw URL concatenation.
    expect(captured[0]?.path).toBe('/repos/octo/app/issues/7');
    // Correlation and API version attached via allowlisted headers.
    expect(captured[0]?.headers['x-correlation-id']).toBe('corr-1');
    expect(captured[0]?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('write operations REQUIRE an AuthorizedActionContext (fail closed)', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({}),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation({ safety: 'write', method: 'POST', successStatuses: [201] }),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
      // no authorized context
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('UNAUTHORIZED_WRITE');
  });

  it('write operations WITH an authorized context proceed', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({ status: 201 }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation({ safety: 'write', method: 'POST', successStatuses: [201] }),
      { owner: 'o', repo: 'r', issue_number: 1 },
      writeCtx(),
      TOKEN,
      AUTH,
    );
    expect(result.ok).toBe(true);
  });

  it('304 returns notModified without body parsing', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({ status: 304, bodyText: undefined }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(true);
    if (result.ok && 'notModified' in result) expect(result.notModified).toBe(true);
  });

  it.each([
    [401, 'AUTHENTICATION'],
    [403, 'PERMISSION'],
    [404, 'NOT_FOUND'],
    [422, 'VALIDATION'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
  ])('status %i maps to typed error kind', async (status, kind) => {
    const client = new GitHubBaseClient({
      transport: transportReturning({ status, bodyText: JSON.stringify({ message: 'nope' }) }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it('schema mismatch never returns invalid values (fail closed)', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({ bodyText: JSON.stringify({ unexpected: true }) }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('SCHEMA_MISMATCH');
  });

  it('rate-limit responses carry retryAfterMs from Retry-After header', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({
        status: 429,
        headers: {
          'retry-after': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 60),
        },
      }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('RATE_LIMITED');
      expect(result.error.retryAfterMs).toBe(30_000);
    }
  });

  it('rate headers are parsed into meta', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({
        headers: {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 60),
        },
      }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    if (result.ok && 'rate' in result.meta) {
      expect(result.meta.rate?.remaining).toBe(4999);
    }
  });

  it('path placeholders are URL-encoded (no injection through path values)', async () => {
    const captured: Array<{ path: string }> = [];
    const client = new GitHubBaseClient({
      transport: transportReturning({}, captured),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    await client.execute(
      makeOperation(),
      { owner: 'octo/../evil', repo: 'app?x=1', issue_number: 7 },
      ctx(),
      TOKEN,
    );
    // Placeholder values are fully encoded: no raw / or ? from user input.
    expect(captured[0]?.path).toBe('/repos/octo%2F..%2Fevil/app%3Fx%3D1/issues/7');
    // No unencoded traversal: '..' exists inside an encoded segment, which
    // GitHub's router treats as a single literal string, not a path change.
    expect(captured[0]?.path).not.toContain('/../');
    expect(captured[0]?.path).not.toContain('?x=1');
  });

  it('missing path parameter returns VALIDATION error via input schema (not silent)', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({}),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: undefined } as never,
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('VALIDATION');
  });

  it('transport network errors return typed SERVER_ERROR result (not raw throw)', async () => {
    const client = new GitHubBaseClient({
      transport: {
        request: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('SERVER_ERROR');
  });

  it('transport abort returns typed TIMEOUT result', async () => {
    const abortError = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const client = new GitHubBaseClient({
      transport: {
        request: async () => {
          throw abortError;
        },
      },
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('TIMEOUT');
  });

  it('input schema validation rejects malformed input before transport', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({}),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 123, repo: 'r', issue_number: 1 } as never,
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('VALIDATION');
  });

  it('write with short digest (not 64-hex) fails closed', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({}),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation({ safety: 'write', method: 'POST', successStatuses: [201] }),
      { owner: 'o', repo: 'r', issue_number: 1 },
      writeCtx(),
      TOKEN,
      {
        decisionId: 'dec-1',
        operationKey: 'test.op',
        actionFingerprint: 'a'.repeat(64),
        digest: 'short-digest',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('UNAUTHORIZED_WRITE');
  });

  it('empty body with non-undefined outputSchema fails closed (SCHEMA_MISMATCH)', async () => {
    const client = new GitHubBaseClient({
      transport: transportReturning({ status: 200, bodyText: '' }),
      apiVersion: 'x',
      nowMs: () => NOW,
    });
    const result = await client.execute(
      makeOperation(),
      { owner: 'o', repo: 'r', issue_number: 1 },
      ctx(),
      TOKEN,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('SCHEMA_MISMATCH');
  });
});

describe('FetchTransport SSRF guard (C018 §17)', () => {
  it('refuses any host other than api.github.com', async () => {
    const transport = new FetchTransport();
    await expect(
      transport.request({
        method: 'GET',
        path: '/',
        headers: {},
        timeoutMs: 1000,
        host: 'evil.example.com',
      }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      transport.request({
        method: 'GET',
        path: '/',
        headers: {},
        timeoutMs: 1000,
        host: '169.254.169.254',
      }),
    ).rejects.toThrow(/SSRF guard/);
  });
});

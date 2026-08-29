import { describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from './csrf';
import { DevGuardApiClient } from './client';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('DevGuardApiClient (C089)', () => {
  it('sends credentials and CSRF, never Authorization, on cookie mutations', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(202, {
        data: {
          id: '00000000-0000-4000-8000-000000000003',
          repositoryId: '22222222-2222-4222-8222-222222222222',
          commandId: 'review_remediation',
          originSurface: 'web',
          status: 'accepted',
          workflowRunId: '00000000-0000-4000-8000-000000000003',
          createdAt: '2026-01-01T00:00:00.000Z',
          links: {
            run: '/api/v1/workflows/00000000-0000-4000-8000-000000000003',
            self: '/api/v1/repositories/22222222-2222-4222-8222-222222222222/commands',
          },
        },
      });
    };
    const client = new DevGuardApiClient({
      fetchImpl,
      getCookieHeader: () => 'devguard_csrf=csrf-token; other=1',
    });
    await client.commands.submit(
      '22222222-2222-4222-8222-222222222222',
      {
        commandId: 'review_remediation',
        definitionVersion: '1',
        input: { pullRequestNumber: 12 },
        originSurface: 'web',
      },
      { signal: new AbortController().signal, idempotencyKey: 'a'.repeat(32) },
    );
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.init.credentials).toBe('include');
    expect(headers.get(CSRF_HEADER)).toBe('csrf-token');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('idempotency-key')).toBe('a'.repeat(32));
    const body = JSON.parse(String(calls[0]?.init.body)) as { originSurface: string };
    expect(body.originSurface).toBe('web');
    expect(calls[0]?.url).toMatch(/^\/api\/v1\/repositories\//);
  });

  it('surfaces requestId from the error envelope and does not retry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        400,
        {
          error: {
            code: 'ORIGIN_FORGED',
            message: 'origin is not allowed',
            requestId: 'req-77',
            retryable: false,
          },
        },
        { 'x-request-id': 'req-77' },
      ),
    );
    const client = new DevGuardApiClient({ fetchImpl, getCookieHeader: () => 'devguard_csrf=x' });
    await expect(
      client.commands.submit(
        '22222222-2222-4222-8222-222222222222',
        {
          commandId: 'review_remediation',
          definitionVersion: '1',
          input: {},
          originSurface: 'web',
        },
        { signal: new AbortController().signal, idempotencyKey: 'b'.repeat(32) },
      ),
    ).rejects.toMatchObject({ code: 'ORIGIN_FORGED', requestId: 'req-77' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps abort of an unsafe method to NETWORK_UNCERTAIN', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    };
    const client = new DevGuardApiClient({ fetchImpl, getCookieHeader: () => 'devguard_csrf=x' });
    const controller = new AbortController();
    const pending = client.auth.logout({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK_UNCERTAIN' });
  });
});

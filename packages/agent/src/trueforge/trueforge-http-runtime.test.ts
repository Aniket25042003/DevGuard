/** CP013 — TrueForge agent runtime: disabled → fail closed (no network); enabled → maps HTTP. */
import { describe, expect, it, vi } from 'vitest';
import { TrueForgeHttpAgentRuntime } from './trueforge-http-runtime.js';

describe('TrueForgeHttpAgentRuntime (CP013)', () => {
  it('disabled: no network call, every op fails PROVIDER_INCOMPATIBLE', async () => {
    const fetchImpl = vi.fn();
    const runtime = new TrueForgeHttpAgentRuntime({
      enabled: false,
      baseUrl: 'http://tf',
      fetchImpl,
    });
    const pre = await runtime.preflight();
    expect(pre).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    const session = await runtime.createSession({ provider: 'trueforge', agentVersion: '1' });
    expect(session).toMatchObject({ ok: false, code: 'PROVIDER_INCOMPATIBLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enabled + identify ok: createSession maps the response', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/api/v1/capabilities'))
        return { ok: true, status: 200, json: async () => ({ data: { sandbox: { enabled: true } } }) };
      if (url.endsWith('/api/v1/sessions'))
        return { ok: true, status: 201, json: async () => ({ sessionId: 's1', threadId: 't1' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const runtime = new TrueForgeHttpAgentRuntime({
      enabled: true,
      baseUrl: 'http://tf',
      fetchImpl,
    });
    const session = await runtime.createSession({ provider: 'trueforge', agentVersion: '1' });
    expect(session).toMatchObject({
      ok: true,
      value: { providerSessionId: 's1', providerThreadId: 't1' },
    });
    expect(calls.length).toBe(2);
  });
});

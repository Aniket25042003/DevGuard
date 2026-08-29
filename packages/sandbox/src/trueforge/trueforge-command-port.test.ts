/** CP013 — TrueForge sandbox command port: disabled → fail closed, no host process. */
import { describe, expect, it, vi } from 'vitest';
import { TrueForgeHttpCommandPort } from './trueforge-command-port.js';

describe('TrueForgeHttpCommandPort (CP013)', () => {
  const command = { command: 'echo hi', args: [], timeoutMs: 1000 } as never;

  it('hostFilesystem is always false and the integration is disabled by default', async () => {
    const fetchImpl = vi.fn();
    const port = new TrueForgeHttpCommandPort({ enabled: false, baseUrl: 'http://tf', fetchImpl });
    expect(port.hostFilesystem).toBe(false);
    const out = await port.execute(command);
    expect(out).toMatchObject({ ok: false, code: 'SERVER_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

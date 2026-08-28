/** CP005 §22 — Postgres local-access port: SQL scoping + linkage mapping. */
import { describe, expect, it } from 'vitest';
import { PostgresLocalRepositoryAccessPort } from '@devguard/db';

type Call = { text: string; values: unknown[] };

function poolWith(respond: (text: string) => Array<Record<string, unknown>>): {
  pool: Parameters<typeof PostgresLocalRepositoryAccessPort>[0] & { calls: Call[] };
} {
  const calls: Call[] = [];
  return {
    pool: {
      calls,
      async query<T>(config: { text: string; values?: unknown[] }): Promise<T[]> {
        calls.push({ text: config.text, values: config.values ?? [] });
        return respond(config.text) as T[];
      },
    } as never,
  };
}

describe('PostgresLocalRepositoryAccessPort (CP005 §22)', () => {
  it('maps an active row to linkage with the installation ref', async () => {
    const { pool } = poolWith(() => [{ status: 'active', installation_id: 'inst-7' }]);
    const port = new PostgresLocalRepositoryAccessPort(pool as never);
    const linkage = await port.findLinkage('repo-1');
    expect(linkage).toEqual({ status: 'active', installationRef: 'inst-7' });
    expect(pool.calls[0]?.values).toEqual(['repo-1']);
    expect(pool.calls[0]?.text).toContain('FROM repositories WHERE id = $1');
  });

  it('returns undefined for an unknown repository (non-enumerating)', async () => {
    const { pool } = poolWith(() => []);
    const port = new PostgresLocalRepositoryAccessPort(pool as never);
    expect(await port.findLinkage('missing')).toBeUndefined();
  });

  it('maps pending/disconnected statuses verbatim and guards unknown statuses', async () => {
    const pending = new PostgresLocalRepositoryAccessPort(
      poolWith(() => [{ status: 'pending', installation_id: 'i1' }]).pool as never,
    );
    expect((await pending.findLinkage('r'))?.status).toBe('pending');

    const unknown = new PostgresLocalRepositoryAccessPort(
      poolWith(() => [{ status: 'bogus', installation_id: 'i2' }]).pool as never,
    );
    // A row whose status is outside the lifecycle set is treated as
    // disconnected (deny) rather than guessed.
    expect(await unknown.findLinkage('r')).toEqual({
      status: 'disconnected',
      installationRef: 'i2',
    });
  });

  it('checks connecting ownership by repository + user', async () => {
    const { pool } = poolWith(() => [{ present: true }]);
    const port = new PostgresLocalRepositoryAccessPort(pool as never);
    expect(await port.isConnectingOwner('repo-1', 'user-9')).toBe(true);
    expect(pool.calls[0]?.text).toContain('connected_by = $2');
    expect(pool.calls[0]?.values).toEqual(['repo-1', 'user-9']);
  });
});

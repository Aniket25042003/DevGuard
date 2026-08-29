/** CP017 — CLI alias mapping + HTTP contract via a mock fetch (no real files). */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ID_BY_VERB,
  DevguardClient,
  HELP,
  runCli,
  type CliDeps,
  type FetchLike,
} from './index.js';

describe('CP017 alias mapping', () => {
  it('maps CLI verbs to the canonical CP001 workflow ids', () => {
    expect(COMMAND_ID_BY_VERB['review']).toBe('review_remediation');
    expect(COMMAND_ID_BY_VERB['fix']).toBe('diagnose_failure');
    expect(COMMAND_ID_BY_VERB['audit']).toBe('security_audit');
    expect(COMMAND_ID_BY_VERB['patch']).toBe('security_patch');
    expect(COMMAND_ID_BY_VERB['implement']).toBe('implement_issue');
  });
});

describe('CP017 DevguardClient contract', () => {
  it('submits a command with originSurface=cli and the bearer token', async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = {
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ?? '',
      };
      return { status: 200, json: async () => ({ runId: 'run-1', status: 'submitted' }) };
    };
    const client = new DevguardClient(
      { apiBase: 'http://api.test', token: 'dgv1_secret' },
      { fetchImpl },
    );
    const res = await client.submit('repo-1', {
      command: 'review_remediation',
      idempotencyKey: 'key-1',
      prNumber: 4,
    });
    expect(res.status).toBe(200);
    expect(captured?.url).toBe('http://api.test/api/v1/repositories/repo-1/commands');
    expect(captured?.headers['authorization']).toBe('Bearer dgv1_secret');
    const body = JSON.parse(captured?.body ?? '{}') as {
      commandId: string;
      originSurface: string;
      input: { pullRequestNumber: number };
    };
    expect(body.commandId).toBe('review_remediation');
    expect(body.originSurface).toBe('cli');
    expect(body.input.pullRequestNumber).toBe(4);
  });

  it('resolves the repo via catalog then lists runs with an origin filter', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/repositories')) {
        return {
          status: 200,
          json: async () => ({ repositories: [{ id: 'repo-1', fullName: 'o/r' }] }),
        };
      }
      return {
        status: 200,
        json: async () => ({
          data: { runs: [{ id: 'r1', status: 'queued', originSurface: 'cli' }], hasMore: false },
        }),
      };
    };
    const client = new DevguardClient({ apiBase: 'http://api.test', token: 't' }, { fetchImpl });
    const cat = await client.repositories();
    expect(cat.status).toBe(200);
    const runs = await client.runsList('repo-1', 'cli');
    expect(runs.status).toBe(200);
    expect(calls[1]).toContain('originSurface=cli');
  });
});

describe('CP017 runCli dispatch', () => {
  it('submits `review --pr 1` and prints the run id', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/repositories')) {
        return {
          status: 200,
          json: async () => ({ repositories: [{ id: 'repo-1', fullName: 'o/r' }] }),
        };
      }
      return { status: 200, json: async () => ({ runId: 'run-1', status: 'submitted' }) };
    };
    const deps: CliDeps = {
      fetchImpl,
      env: { DEVGUARD_TOKEN: 'dgv1_token' } as NodeJS.ProcessEnv,
      cwd: process.cwd(),
      ctimeMs: () => 0,
    };
    const result = await runCli(['review', '--repo', 'o/r', '--pr', '1', '--json'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('"runId":"run-1"');
  });

  it('help prints usage', async () => {
    const deps: CliDeps = {
      fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
      env: {} as NodeJS.ProcessEnv,
      cwd: process.cwd(),
      ctimeMs: () => 0,
    };
    const result = await runCli(['help'], deps);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('devguard');
    expect(HELP).toContain('review --pr <n>');
  });
});

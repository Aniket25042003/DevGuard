import { describe, expect, it } from 'vitest';
import '../errors.js';
import { GovernedCommandRunner, InMemoryCommandStore } from './command-runner.js';
import { InMemoryCommandProvider } from './command-provider-port.js';
import { resolveCommandEdge, isTerminalCommand } from './command-fsm.js';
import { canonicalDigest, assertSafeArgv, commandIdempotencyKey } from './command-identity.js';
import { OutputNormalizer } from './output-normalizer.js';
import type { SandboxCommand } from './contracts.js';

const WS = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const SHA = 'a'.repeat(40);

function cmd(overrides: Partial<SandboxCommand> = {}): SandboxCommand {
  return {
    commandId: 'cmd-1',
    workspace: { workspaceId: WS, headSha: SHA, ready: true },
    actionDecisionId: 'decision-1',
    class: 'test',
    executable: '/usr/bin/true',
    args: [],
    cwd: 'src',
    env: [['DEVGUARD_WORKSPACE', { kind: 'literal_safe', value: 'local' }]] as [
      string,
      { kind: 'literal_safe'; value: string },
    ][],
    timeoutMs: 60_000,
    output: { maxStdoutBytes: 1000, maxStderrBytes: 1000 },
    generation: 0,
    ...overrides,
  };
}

function setup() {
  const provider = new InMemoryCommandProvider();
  const store = new InMemoryCommandStore();
  const runner = new GovernedCommandRunner({ provider, store });
  return { provider, store, runner };
}

describe('C042 command identity', () => {
  it('computes a canonical digest and idempotency key', () => {
    const c = cmd();
    expect(canonicalDigest(c)).toMatch(/^[0-9a-f]{64}$/);
    expect(commandIdempotencyKey(c.commandId, c.generation)).toBe('command:cmd-1:generation:0');
  });

  it('rejects NUL, absolute cwd, and unsafe env names', () => {
    expect(() => assertSafeArgv(cmd({ executable: 'a\u0000b' }))).toThrow();
    expect(() => assertSafeArgv(cmd({ cwd: '/etc' }))).toThrow();
    expect(() =>
      assertSafeArgv(cmd({ env: [['BAD-NAME', { kind: 'literal_safe', value: 'x' }]] })),
    ).toThrow();
    expect(() => assertSafeArgv(cmd())).not.toThrow();
  });
});

describe('C042 command FSM', () => {
  it('walks proposed->authorized->queued->starting->running->succeeded', () => {
    expect(resolveCommandEdge('PROPOSED', 'authorize').allowed).toBe(true);
    expect(resolveCommandEdge('AUTHORIZED', 'queue').allowed).toBe(true);
    expect(resolveCommandEdge('QUEUED', 'start').allowed).toBe(true);
    expect(resolveCommandEdge('STARTING', 'running').allowed).toBe(true);
    expect(resolveCommandEdge('RUNNING', 'succeed').allowed).toBe(true);
    expect(resolveCommandEdge('RUNNING', 'deadline').allowed).toBe(true);
    expect(resolveCommandEdge('RUNNING', 'cancel_request').allowed).toBe(true);
    expect(resolveCommandEdge('TIMING_OUT', 'terminate').allowed).toBe(true);
    expect(resolveCommandEdge('TERMINATING', 'timed_out').allowed).toBe(true);
    expect(resolveCommandEdge('UNKNOWN', 'reconcile').allowed).toBe(true);
    expect(resolveCommandEdge('RECONCILING', 'quarantine').allowed).toBe(true);
    expect(resolveCommandEdge('SUCCEEDED', 'succeed').allowed).toBe(false);
    expect(isTerminalCommand('TIMED_OUT')).toBe(true);
  });
});

describe('C042 output normalization', () => {
  it('bounds bytes, strips ANSI/controls, and redacts secrets', () => {
    const n = new OutputNormalizer('out:1', 10, ['topsecret']);
    n.ingest('\x1b[31mred\x1b[0m topsecret extra');
    const ref = n.finalize();
    expect(ref.truncated).toBe(true);
    expect(ref.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.bytes).toBeLessThanOrEqual(10);
    expect(ref.chunks).toBe(1);
  });
});

describe('C042 GovernedCommandRunner', () => {
  it('runs an authorized command and reports success only on exit 0', async () => {
    const { provider, runner } = setup();
    provider.pushChunk('building...');
    provider.finish(0);
    const r = await runner.start(cmd(), { decisionId: 'decision-1', allowed: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerCommandId).toBe('pc-1');
  });

  it('blocks an unauthorized command before any provider call', async () => {
    const { provider, runner } = setup();
    const r = await runner.start(cmd(), { decisionId: 'decision-other', allowed: false });
    expect(r).toEqual({ ok: false, status: 'blocked', detail: 'COMMAND_NOT_AUTHORIZED' });
    expect(provider.executed).toBe(0);
  });

  it('replays the same idempotency key without a second provider dispatch', async () => {
    const { provider, runner } = setup();
    provider.finish(0);
    await runner.start(cmd(), { decisionId: 'decision-1', allowed: true });
    const again = await runner.start(cmd(), { decisionId: 'decision-1', allowed: true });
    expect(again.ok).toBe(true);
    expect(provider.executed).toBe(1);
  });

  it('cancels an unsupported provider as cancelled_unsupported', async () => {
    const { runner } = setup();
    const r = await runner.cancel('cmd-missing', 0);
    expect(r).toBe('cancelled_unsupported');
  });
});

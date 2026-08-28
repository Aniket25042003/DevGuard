/**
 * CP006 §22 — command bus: list (MVP only), submit normalization + policy gate,
 * alias resolution, origin-forge rejection, idempotent dedupe, atomic persist.
 */
import { describe, expect, it } from 'vitest';
import {
  CommandBus,
  CommandDisabledError,
  CommandOriginForgedError,
  idempotencyKeyHashOf,
  listAvailableCommands,
  type CommandBusPersistencePort,
  type CreateQueuedRunInput,
} from '../index.js';

class FakePersistence implements CommandBusPersistencePort {
  readonly calls: CreateQueuedRunInput[] = [];
  private mode: 'created' | 'replayed' = 'created';

  setMode(mode: 'created' | 'replayed'): void {
    this.mode = mode;
  }

  async createQueuedRun(
    input: CreateQueuedRunInput,
  ): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  > {
    const runId = input.runId;
    this.calls.push(input);
    return this.mode === 'created' ? { outcome: 'created', runId } : { outcome: 'replayed', runId };
  }
}

const KEY = 'idempotency-key-0001';

function makeBus(persistence: FakePersistence = new FakePersistence(), newRunId?: () => string) {
  return { bus: new CommandBus({ persistence, newRunId }), persistence };
}

describe('listAvailableCommands (CP006 §22)', () => {
  it('advertises exactly the MVP commands with their input schema ids', () => {
    const list = listAvailableCommands();
    const ids = list.map((cmd) => cmd.workflowId).sort();
    expect(ids).toEqual(
      [
        'diagnose_failure',
        'implement_issue',
        'review_remediation',
        'security_audit',
        'security_patch',
      ].sort(),
    );
    for (const cmd of list) {
      expect(cmd.inputSchemaId).toMatch(/^input\./);
    }
  });

  it('does NOT advertise extension workflows (dependency_upgrade etc.)', () => {
    const ids = listAvailableCommands().map((cmd) => cmd.workflowId);
    expect(ids).not.toContain('dependency_upgrade');
    expect(ids).not.toContain('manual_refactor');
    expect(ids).not.toContain('repository_health_check');
  });
});

describe('CommandBus.submit (CP006 §22)', () => {
  it('resolves a client alias to the canonical id and persists a queued run', async () => {
    const calls: CreateQueuedRunInput[] = [];
    const persistence: CommandBusPersistencePort = {
      async createQueuedRun(input) {
        calls.push(input);
        return { outcome: 'created', runId: input.runId };
      },
    };
    const bus = new CommandBus({ persistence, newRunId: () => 'run-0001' });
    const result = await bus.submit({
      command: { commandId: 'review' },
      repositoryId: 'repo-1',
      originSurface: 'cli',
      idempotencyKey: KEY,
      createdBy: 'user-1',
    });
    expect(result).toEqual({ runId: 'run-0001', replayed: false });
    expect(calls.length).toBe(1);
    expect(calls[0]?.workflowType).toBe('review_remediation');
    expect(calls[0]?.originSurface).toBe('cli');
    expect(calls[0]?.triggerType).toBe('manual');
    expect(calls[0]?.runId).toBe('run-0001');
    expect(calls[0]?.idempotencyKeyHash).toBe(idempotencyKeyHashOf(KEY));
  });

  it('persists exactly one run when the same idempotency key is replayed', async () => {
    const persistence = new FakePersistence();
    persistence.setMode('replayed');
    const { bus } = makeBus(persistence, () => 'run-0099');
    const first = await bus.submit({
      command: { commandId: 'review' },
      repositoryId: 'repo-1',
      originSurface: 'cli',
      idempotencyKey: KEY,
    });
    expect(first.replayed).toBe(true);
    expect(first.runId).toBe('run-0099');
    // Replay must not create a new outbox/run.
    expect(persistence.calls.length).toBe(1);
  });

  it('rejects an unknown command with COMMAND_UNKNOWN', async () => {
    const { bus } = makeBus();
    await expect(
      bus.submit({
        command: { commandId: 'does_not_exist' },
        repositoryId: 'repo-1',
        originSurface: 'cli',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_UNKNOWN' });
  });

  it('rejects a case-mangled alias (no case folding)', async () => {
    const { bus } = makeBus();
    await expect(
      bus.submit({
        command: { commandId: 'Review' },
        repositoryId: 'repo-1',
        originSurface: 'cli',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_UNKNOWN' });
  });

  it('denies extension (non-MVP) commands with COMMAND_NO_LONGER_ALLOWED', async () => {
    const { bus, persistence } = makeBus();
    await expect(
      bus.submit({
        command: { commandId: 'dependency_upgrade' },
        repositoryId: 'repo-1',
        originSurface: 'cli',
        idempotencyKey: KEY,
      }),
    ).rejects.toBeInstanceOf(CommandDisabledError);
    expect(persistence.calls.length).toBe(0); // denied before any write
  });

  it('rejects a forged github_comment origin from an HTTP caller', async () => {
    const { bus, persistence } = makeBus();
    await expect(
      bus.submit({
        command: { commandId: 'review' },
        repositoryId: 'repo-1',
        originSurface: 'github_comment',
        idempotencyKey: KEY,
      }),
    ).rejects.toBeInstanceOf(CommandOriginForgedError);
    expect(persistence.calls.length).toBe(0);
  });

  it('permits github_comment when the server-side GitHub path asserts it (trustedSurface)', async () => {
    const { bus, persistence } = makeBus();
    const result = await bus.submit({
      command: { commandId: 'review' },
      repositoryId: 'repo-1',
      originSurface: 'github_comment',
      idempotencyKey: KEY,
      trustedSurface: true,
    });
    expect(result.replayed).toBe(false);
    expect(persistence.calls[0]?.triggerType).toBe('webhook');
  });

  it('rejects an idempotency key shorter than 16 chars', async () => {
    const { bus } = makeBus();
    await expect(
      bus.submit({
        command: { commandId: 'review' },
        repositoryId: 'repo-1',
        originSurface: 'cli',
        idempotencyKey: 'short',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

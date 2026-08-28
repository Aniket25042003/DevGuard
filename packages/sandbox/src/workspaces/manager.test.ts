/**
 * C041 §22 — WorkspaceManager orchestration with deterministic in-memory fakes.
 *
 * Verifies the create→provision→checkout→verify→READY path and every
 * fail-closed boundary: capability denial, ref movement, checkout mismatch,
 * stale fence, idempotent replay, and unproven destruction.
 */
import { describe, expect, it } from 'vitest';
import { parseEvent, type EventEnvelopeShape } from '@devguard/contracts';
import { WorkspaceManager, type CreateWorkspaceInput } from './manager.js';
import { makeSandboxEvent, SANDBOX_EVENT_TYPES } from '../events.js';
import type { WorkspaceManagerPorts } from './ports.js';
import type { ProviderWorkspaceCreateResult, ProviderDestroyResult } from './ports.js';
import type { CheckoutSelector, ResolvedCheckout, ResolvedCheckoutInput } from './selector.js';
import type { ProviderCapabilityManifest, WorkspaceCapability } from './capability-gate.js';
import type { WorkspaceFence } from './fence.js';
import type {
  WorkspaceLeaseRenewal,
  WorkspaceRecord,
  WorkspaceReservation,
  WorkspaceTransitionInput,
  WorkspaceTransitionResult,
} from './state.js';
import type { WorkspaceId } from '../ids.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = 1_700_000_000_000;

const REQUIRED: readonly WorkspaceCapability[] = [
  'workspace.create',
  'workspace.inspect',
  'workspace.cancel',
  'workspace.destroy',
  'isolation.process',
  'isolation.filesystem',
  'isolation.no_host_bind',
  'limits.cpu',
  'limits.memory',
  'limits.network',
  'limits.secrets',
  'limits.cancellation',
];

function fullManifest(): ProviderCapabilityManifest {
  return {
    provider: 'trueforge',
    providerVersion: '1.0.0',
    capabilities: [
      ...REQUIRED.map((name) => ({ name, verified: true })),
      { name: 'checkout.native', verified: false },
      { name: 'checkout.sandboxed_git', verified: true },
    ],
  };
}

const commitSelector: CheckoutSelector = { kind: 'commit', sha: SHA_A };

function makeResolved(overrides: Partial<ResolvedCheckoutInput> = {}): ResolvedCheckout {
  return {
    repositoryId: REPO_ID,
    canonicalOwner: 'devguard',
    canonicalName: 'demo',
    selector: commitSelector,
    resolvedSha: SHA_A,
    remoteFingerprint: 'github.com/devguard/demo',
    resolvedAtMs: NOW,
    ...overrides,
  };
}

class InMemoryWorkspaceStore {
  private records = new Map<string, WorkspaceRecord>();

  async load(workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
    const record = this.records.get(workspaceId.toString());
    if (!record) throw new Error(`no workspace ${String(workspaceId)}`);
    return record;
  }

  async loadByRunId(runId: string): Promise<WorkspaceRecord | undefined> {
    return [...this.records.values()].find((record) => record.runId === runId);
  }

  async reserve(input: WorkspaceReservation): Promise<WorkspaceRecord> {
    const record: WorkspaceRecord = {
      workspaceId: input.workspaceId,
      runId: input.runId,
      sessionId: input.sessionId,
      repositoryId: input.repositoryId,
      selector: input.selector,
      requestedRefKind: input.selector.kind,
      requestedRef:
        input.selector.kind === 'commit'
          ? input.selector.sha.slice(0, 12)
          : input.selector.kind === 'pull_request_head'
            ? `pr:${input.selector.number}`
            : input.selector.name,
      limitProfileId: input.limitProfileId,
      status: 'REQUESTED',
      generation: input.generation,
      leaseOwner: input.leaseOwner,
      leaseToken: input.leaseToken,
      leaseExpiresAtMs: input.leaseExpiresAtMs,
      rowVersion: 1,
      createdAtMs: input.createdAtMs,
    };
    this.records.set(input.workspaceId.toString(), record);
    return record;
  }

  async tryTransition(input: WorkspaceTransitionInput): Promise<WorkspaceTransitionResult> {
    const current = this.records.get(input.workspaceId.toString());
    if (!current) return { applied: false, record: {} as WorkspaceRecord };
    if (
      current.rowVersion !== input.expectedRowVersion ||
      current.status !== input.expectedStatus
    ) {
      return { applied: false, record: current };
    }
    const next = {
      ...current,
      ...input.patch,
      status: input.to,
      rowVersion: current.rowVersion + 1,
    };
    this.records.set(input.workspaceId.toString(), next);
    return { applied: true, record: next };
  }

  async renewLease(input: WorkspaceLeaseRenewal): Promise<WorkspaceTransitionResult> {
    const current = this.records.get(input.workspaceId.toString());
    if (
      !current ||
      current.rowVersion !== input.rowVersion ||
      current.leaseToken !== input.expectedLeaseToken
    ) {
      return { applied: false, record: current ?? ({} as WorkspaceRecord) };
    }
    const next = {
      ...current,
      leaseToken: input.newLeaseToken,
      leaseExpiresAtMs: input.leaseExpiresAtMs,
      rowVersion: current.rowVersion + 1,
    };
    this.records.set(input.workspaceId.toString(), next);
    return { applied: true, record: next };
  }

  get(id: WorkspaceId): WorkspaceRecord | undefined {
    return this.records.get(id.toString());
  }
}

interface HarnessOptions {
  manifest?: ProviderCapabilityManifest;
  resolveShouldThrow?: boolean;
  observeSha?: string;
  providerDestroyed?: boolean;
  providerCreateThrows?: boolean;
  attestThrows?: boolean;
  eventSinkThrows?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const store = new InMemoryWorkspaceStore();
  const events: EventEnvelopeShape[] = [];
  const providerCreateCalls: Array<{
    generation: number;
    leaseToken: string;
    leaseExpiresAtMs: number;
  }> = [];
  const providerDestroyCalls: Array<{
    generation: number;
    leaseToken: string;
    leaseExpiresAtMs: number;
  }> = [];

  const ports: WorkspaceManagerPorts = {
    resolver: {
      resolve: async () => {
        if (options.resolveShouldThrow) throw new Error('upstream dead');
        return makeResolved();
      },
    },
    capabilityProbe: { probe: async () => options.manifest ?? fullManifest() },
    provider: {
      create: async (input): Promise<ProviderWorkspaceCreateResult> => {
        providerCreateCalls.push({
          generation: input.generation,
          leaseToken: input.leaseToken,
          leaseExpiresAtMs: input.leaseExpiresAtMs,
        });
        if (options.providerCreateThrows) throw new Error('provider create transport failure');
        return {
          providerWorkspaceId: 'tfws_1' as never,
          created: true,
          snapshot: {
            providerWorkspaceId: 'tfws_1' as never,
            status: 'ready',
            observedHeadSha: options.observeSha ?? SHA_A,
            observedRemoteFingerprint: 'github.com/devguard/demo',
            treeHash: 'c'.repeat(40),
          },
        };
      },
      inspect: async () => ({ providerWorkspaceId: 'tfws_1' as never, status: 'ready' }),
      destroy: async (input): Promise<ProviderDestroyResult> => {
        providerDestroyCalls.push({
          generation: input.generation,
          leaseToken: input.leaseToken,
          leaseExpiresAtMs: input.leaseExpiresAtMs,
        });
        return {
          destroyed: options.providerDestroyed ?? false,
          snapshot: { providerWorkspaceId: 'tfws_1' as never, status: 'destroyed' as const },
        };
      },
    },
    verifier: {
      attest: async (attestation) => {
        if (options.attestThrows) throw new Error('attestation store unavailable');
        return attestation;
      },
    },
    store: {
      load: (id: WorkspaceId) => store.load(id),
      loadByRunId: (runId: string) => store.loadByRunId(runId),
      reserve: (input: WorkspaceReservation) =>
        store.reserve({ ...input, workspaceId: WORKSPACE_ID as WorkspaceId }),
      tryTransition: (input: WorkspaceTransitionInput) => store.tryTransition(input),
      renewLease: (input: WorkspaceLeaseRenewal) => store.renewLease(input),
    },
    events: {
      emit: async (envelope: EventEnvelopeShape) => {
        if (options.eventSinkThrows) throw new Error('outbox unavailable');
        events.push(envelope);
      },
    },
  };

  const manager = new WorkspaceManager({
    ports,
    leaseTtlMs: 60_000,
    checkoutExecution: 'sandboxed_git',
    now: () => NOW,
  });

  function input(overrides: Partial<CreateWorkspaceInput> = {}): CreateWorkspaceInput {
    return {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      repositoryId: REPO_ID,
      selector: commitSelector,
      limitProfileId: 'limits/default' as never,
      nowMs: NOW,
      ...overrides,
    };
  }

  function currentFence(id: WorkspaceId): WorkspaceFence {
    const record = store.get(id);
    expect(record).toBeDefined();
    return {
      workspaceId: id,
      runId: record?.runId ?? RUN_ID,
      generation: record?.generation ?? 1,
      leaseToken: record?.leaseToken ?? '',
      leaseExpiresAtMs: record?.leaseExpiresAtMs ?? NOW,
    };
  }

  return { manager, store, events, input, currentFence, providerCreateCalls, providerDestroyCalls };
}

describe('WorkspaceManager.create (C041 §12/§23)', () => {
  it('provisions an exact-SHA workspace to READY and emits ready', async () => {
    const { manager, store, events, input } = makeHarness();
    const ref = await manager.create(input());
    expect(ref.status).toBe('READY');
    expect(ref.resolvedSha).toBe(SHA_A);
    expect(store.get(ref.workspaceId)?.verifiedHeadSha).toBe(SHA_A);
    expect(events.some((event) => event.type === 'sandbox.workspace.ready')).toBe(true);
  });

  it('replays existing run ownership deterministically (idempotent)', async () => {
    const { manager, events, input } = makeHarness();
    const first = await manager.create(input());
    const second = await manager.create(input());
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.status).toBe('READY');
    expect(events.filter((event) => event.type === 'sandbox.workspace.created')).toHaveLength(1);
  });

  it('rejects a replay whose repository binding differs from the original (no silent redirect)', async () => {
    const { manager, input } = makeHarness();
    await manager.create(input());
    await expect(
      manager.create(input({ repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
    ).rejects.toThrowError(/WORKSPACE_REPLAY_MISMATCH/);
  });

  it('fails closed when a required isolation capability is missing', async () => {
    const { manager, input } = makeHarness({
      manifest: {
        provider: 'trueforge',
        providerVersion: '1.0.0',
        capabilities: fullManifest().capabilities.filter(
          (claim) => claim.name !== 'isolation.process',
        ),
      },
    });
    await expect(manager.create(input())).rejects.toThrowError(/SANDBOX_ISOLATION_UNVERIFIED/);
  });

  it('fails closed when the ref resolver cannot resolve', async () => {
    const { manager, input } = makeHarness({ resolveShouldThrow: true });
    await expect(manager.create(input())).rejects.toThrowError(/upstream dead/);
  });

  it('quarantines (never uses) a workspace whose observed HEAD differs from the authorized SHA', async () => {
    const { manager, store, input } = makeHarness({ observeSha: SHA_B });
    await expect(manager.create(input())).rejects.toThrowError(/CHECKOUT_MISMATCH/);
    expect(store.get(WORKSPACE_ID as WorkspaceId)?.status).toBe('QUARANTINED');
  });

  it('passes the full lease fence (generation, token, expiry) to provider.create', async () => {
    const { manager, input, providerCreateCalls } = makeHarness();
    await manager.create(input());
    expect(providerCreateCalls).toHaveLength(1);
    expect(providerCreateCalls[0]!.generation).toBe(1);
    expect(providerCreateCalls[0]!.leaseToken).toBeTruthy();
    expect(providerCreateCalls[0]!.leaseExpiresAtMs).toBeGreaterThan(0);
  });

  it('quarantines the reservation when provider.create rejects or times out instead of stranding PROVISIONING', async () => {
    const { manager, store, input, events } = makeHarness({ providerCreateThrows: true });
    await expect(manager.create(input())).rejects.toThrowError(/provider create transport failure/);
    expect(store.get(WORKSPACE_ID as WorkspaceId)?.status).toBe('QUARANTINED');
    expect(store.get(WORKSPACE_ID as WorkspaceId)?.failureCode).toBe('WORKSPACE_QUARANTINED');
    expect(events.some((event) => event.type === 'sandbox.workspace.quarantined')).toBe(true);
  });

  it('moves a workspace to FAILED (cleanup-required) when attestation persistence fails, never stranding in VERIFYING', async () => {
    const { manager, store, input } = makeHarness({ attestThrows: true });
    await expect(manager.create(input())).rejects.toThrowError(/attestation store unavailable/);
    const record = store.get(WORKSPACE_ID as WorkspaceId);
    expect(record?.status).toBe('FAILED');
    expect(record?.failureCode).toBe('CHECKOUT_ATTESTATION_FAILED');
  });

  it('does not strand the lifecycle when the event sink fails (publication is non-fatal after CAS)', async () => {
    const { manager, input } = makeHarness({ eventSinkThrows: true });
    const ref = await manager.create(input());
    expect(ref.status).toBe('READY');
  });
});

describe('Sandbox event registration (C004 canonical parity)', () => {
  it('emits sandbox events that the canonical parseEvent registry accepts', () => {
    const envelope = makeSandboxEvent({
      type: SANDBOX_EVENT_TYPES.workspaceRequested,
      aggregate: { type: 'workspace', id: WORKSPACE_ID },
      occurredAt: new Date(NOW).toISOString(),
      actor: { kind: 'system', id: 'sandbox' },
      payload: {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        requestedRefKind: 'commit',
        requestedRef: SHA_A.slice(0, 12),
      },
    });
    const parsed = parseEvent(envelope);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.type).toBe(SANDBOX_EVENT_TYPES.workspaceRequested);
  });
});

describe('WorkspaceManager fencing (C041 §19)', () => {
  it('renews with the current lease token; the pre-renewal token then fails closed', async () => {
    const { manager, input, currentFence } = makeHarness();
    const ref = await manager.create(input());
    const before = currentFence(ref.workspaceId);
    const renewed = await manager.renewLease(ref.workspaceId, before);
    expect(renewed.leaseToken).not.toBe(before.leaseToken);
    await expect(manager.renewLease(ref.workspaceId, before)).rejects.toThrowError(
      /WORKSPACE_FENCE_REJECTED/,
    );
  });
});

describe('WorkspaceManager.requestDestroy (C041 §11/§18)', () => {
  it('returns destroyed only when the provider proves absence', async () => {
    const { manager, store, input, currentFence } = makeHarness({ providerDestroyed: true });
    const ref = await manager.create(input());
    await expect(
      manager.requestDestroy(ref.workspaceId, 'run_complete', currentFence(ref.workspaceId)),
    ).resolves.toBe('destroyed');
    expect(store.get(ref.workspaceId)?.status).toBe('DESTROYED');
  });

  it('quarantines when destruction cannot be proven, never claiming cleaned', async () => {
    const { manager, store, input, currentFence } = makeHarness({ providerDestroyed: false });
    const ref = await manager.create(input());
    await expect(
      manager.requestDestroy(ref.workspaceId, 'run_complete', currentFence(ref.workspaceId)),
    ).resolves.toBe('quarantined');
    expect(store.get(ref.workspaceId)?.status).toBe('QUARANTINED');
  });

  it('rejects a stale generation fence', async () => {
    const { manager, input, currentFence } = makeHarness({ providerDestroyed: true });
    const ref = await manager.create(input());
    const stale = { ...currentFence(ref.workspaceId), generation: 99 };
    await expect(
      manager.requestDestroy(ref.workspaceId, 'run_complete', stale),
    ).rejects.toThrowError(/WORKSPACE_FENCE_REJECTED/);
  });
});

describe('WorkspaceManager.inspect (C041 §13)', () => {
  it('reports cleanupRequired for a quarantine', async () => {
    const { manager, input } = makeHarness({ observeSha: SHA_B });
    await expect(manager.create(input())).rejects.toThrow();
    const view = await manager.inspect(WORKSPACE_ID as WorkspaceId);
    expect(view.status).toBe('QUARANTINED');
    expect(view.cleanupRequired).toBe(true);
  });
});

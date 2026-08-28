import { describe, expect, it } from 'vitest';
import type { EventEnvelopeShape } from '@devguard/contracts';
import { createStartupPreflight, detectDigestDrift } from './preflight.js';
import { InMemorySnapshotStore, type RawProviderChannel } from './ports.js';
import { AGENT_EVENT_TYPES } from './events.js';
import {
  snapshotDigest,
  contractSnapshotSchema,
  snapshotId,
  type ContractSnapshot,
} from './snapshot.js';
import { AGENT_CAPABILITY_SUITE_VERSION } from './snapshot.js';

const ENDPOINT = 'https://trueforge.example:8443';

function snapshotWith(opts: {
  status: ContractSnapshot['status'];
  capabilities: Record<string, boolean>;
  checkedAt?: string;
  staleAfterMs?: number;
}): ContractSnapshot {
  const digest = snapshotDigest({
    endpointIdentity: ENDPOINT,
    provider: 'trueforge',
    serverVersion: '2026.08.1',
    suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    capabilities: opts.capabilities,
    fatalProperties: [],
  });
  return contractSnapshotSchema.parse({
    id: snapshotId(digest, 'run-seed'),
    verificationRunId: 'a1b2c3d4-0000-4000-8000-000000000009',
    endpointIdentity: ENDPOINT,
    provider: 'trueforge',
    serverVersion: '2026.08.1',
    suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    capabilities: opts.capabilities,
    fatalProperties: [],
    status: opts.status,
    failureReasons: [],
    checkedAt: opts.checkedAt ?? '2026-08-27T00:00:00.000Z',
    digest,
    staleAfterMs: opts.staleAfterMs ?? 86_400_000,
  });
}

/** All capabilities verified true — required for a genuinely COMPATIBLE status. */
const ALL_CAPS: Record<string, boolean> = {
  session_create: true,
  session_get: true,
  turn_create: true,
  turn_get: true,
  one_active_turn: true,
  event_stream: true,
  event_cursor: true,
  event_delta: true,
  event_replay: true,
  mcp_interception: true,
  required_action_resume: true,
  checkpoint_replay: true,
  sandbox: true,
  cancellation: true,
  subagents: true,
  context_compaction: true,
  final_response: true,
  idempotency_semantics: true,
};

function channel(): RawProviderChannel {
  return {
    endpointIdentity: ENDPOINT,
    provider: 'trueforge',
    identify: async () => ({
      provider: 'trueforge',
      serverVersion: '2026.08.1',
    }),
    runProbe: async () => ({ ok: true, verifiedCapabilities: [] }),
    health: async () => ({ available: true }),
    detectsDirectMutativeGithubTools: async () => false,
  };
}

function nowMs() {
  return Date.parse('2026-08-27T12:00:00.000Z');
}

async function seededStore(snapshot: ContractSnapshot) {
  const store = new InMemorySnapshotStore();
  await store.record(snapshot);
  return store;
}

describe('C036 startup preflight gate', () => {
  it('fails closed when no contract snapshot exists', async () => {
    const store = new InMemorySnapshotStore();
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => '2026-08-27T00:00:00.000Z', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.missingMandatory.length).toBeGreaterThan(0);
  });

  it('fails closed when the snapshot is not operational', async () => {
    const store = await seededStore(
      snapshotWith({
        status: 'INCOMPATIBLE',
        capabilities: { ...ALL_CAPS, mcp_interception: false },
      }),
    );
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.status).toBe('INCOMPATIBLE');
  });

  it('declares readiness for a current COMPATIBLE snapshot', async () => {
    const store = await seededStore(snapshotWith({ status: 'COMPATIBLE', capabilities: ALL_CAPS }));
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('COMPATIBLE');
    expect(result.missingMandatory).toEqual([]);
  });

  it('fails readiness when the snapshot is stale', async () => {
    const store = await seededStore(
      snapshotWith({ status: 'COMPATIBLE', capabilities: ALL_CAPS, staleAfterMs: 60_000 }),
    );
    // now (12:00) is far past the 00:00 checkedAt + 60s window.
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/stale|integrity/i);
  });

  it('fails readiness when a mandatory capability is unverified', async () => {
    const store = await seededStore(
      snapshotWith({
        status: 'INCOMPATIBLE',
        capabilities: { ...ALL_CAPS, mcp_interception: false },
      }),
    );
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.missingMandatory).toContain('mcp_interception');
  });

  it('is ready when an operational snapshot is missing only an optional capability', async () => {
    const store = await seededStore(
      snapshotWith({ status: 'DEGRADED', capabilities: { ...ALL_CAPS, subagents: false } }),
    );
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('DEGRADED');
    expect(result.missingOptional).toContain('subagents');
  });

  it('rejects a tampered/corrupted COMPATIBLE snapshot instead of granting readiness', async () => {
    const good = snapshotWith({ status: 'COMPATIBLE', capabilities: ALL_CAPS });
    // Corrupt a persisted snapshot by flipping a mandatory capability after the
    // digest+status were sealed — the store now returns evidence that no longer
    // verifies (changed claim content under the same immutable digest).
    const tampered = contractSnapshotSchema.parse({
      ...good,
      capabilities: { ...good.capabilities, mcp_interception: false },
    });
    const store = await seededStore(tampered as ContractSnapshot);
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => 'x', nowMs },
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/integrity/i);
  });

  it('detects digest drift and disables readiness, emitting a drift event', async () => {
    const store = await seededStore(snapshotWith({ status: 'COMPATIBLE', capabilities: ALL_CAPS }));
    const emitted: EventEnvelopeShape[] = [];
    const preflight = createStartupPreflight({
      channel: channel(),
      store,
      clock: { nowIso: () => '2026-08-27T12:00:00.000Z', nowMs },
      emit: (envelope) => emitted.push(envelope),
      liveIdentify: async () => ({
        endpointIdentity: ENDPOINT,
        provider: 'trueforge',
        serverVersion: '2030.99.99', // drifted
      }),
    });
    const result = await preflight.run();
    expect(result.ready).toBe(false);
    expect(result.driftDetected).toBe(true);
    expect(emitted.some((e) => e.type === AGENT_EVENT_TYPES.contractDrift)).toBe(true);
  });

  it('detectDigestDrift is true exactly when the sealed identity changes', () => {
    const snapshot = snapshotWith({ status: 'COMPATIBLE', capabilities: ALL_CAPS });
    const same = { endpointIdentity: ENDPOINT, provider: 'trueforge', serverVersion: '2026.08.1' };
    const drifted = {
      endpointIdentity: ENDPOINT,
      provider: 'trueforge',
      serverVersion: '2026.09.0',
    };
    expect(detectDigestDrift(snapshot, same)).toBe(false);
    expect(detectDigestDrift(snapshot, drifted)).toBe(true);
  });
});

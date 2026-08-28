import { describe, expect, it } from 'vitest';
import type { EventEnvelopeShape } from '@devguard/contracts';
import { createContractVerifier } from './verifier.js';
import {
  InMemorySnapshotStore,
  VERIFICATION_PROBE_SUITE,
  type RawProviderChannel,
} from './ports.js';
import { AGENT_EVENT_TYPES } from './events.js';
import type { ContractSnapshot } from './snapshot.js';

const ENDPOINT = 'https://trueforge.example:8443';

function channel(overrides: Partial<RawProviderChannel> = {}): RawProviderChannel {
  return {
    endpointIdentity: ENDPOINT,
    provider: 'trueforge',
    identify: async () => ({
      provider: 'trueforge',
      serverVersion: '2026.08.1',
    }),
    runProbe: async (spec) => ({ ok: true, verifiedCapabilities: [...spec.capabilityNames] }),
    health: async () => ({ available: true }),
    detectsDirectMutativeGithubTools: async () => false,
    ...overrides,
  };
}

function fixedClock() {
  let nowMs = Date.parse('2026-08-27T00:00:00.000Z');
  return {
    clock: { nowIso: () => new Date(nowMs).toISOString(), nowMs: () => nowMs },
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

let uuidCounter = 0;
function ids() {
  return {
    uuid: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
  };
}

function setup(overrides: Partial<RawProviderChannel> = {}, staleAfterMs = 600_000) {
  const ch = channel(overrides);
  const store = new InMemorySnapshotStore();
  const emitted: EventEnvelopeShape[] = [];
  const { clock, advance } = fixedClock();
  const verifier = createContractVerifier({
    channel: ch,
    store,
    clock,
    ids: ids(),
    emit: (envelope) => emitted.push(envelope),
    staleAfterMs,
  });
  return { ch, store, emitted, verifier, advance, clock };
}

describe('C036 contract verifier', () => {
  it('verifies a fully compatible runtime and persists an immutable snapshot', async () => {
    const { verifier, store, emitted } = setup();
    const result = await verifier.verify();
    expect(result.status).toBe('COMPATIBLE');
    expect(result.verdict).toBe('COMPATIBLE');
    expect(result.reused).toBe(false);
    expect(result.snapshot.id).toMatch(/^[0-9a-f]{64}$/);

    const stored = await store.loadCurrent(ENDPOINT);
    expect(stored?.status).toBe('COMPATIBLE');
    expect(stored?.capabilities['mcp_interception']).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe(AGENT_EVENT_TYPES.capabilitiesVerified);
  });

  it('reuses a current, fresh, operational snapshot without re-probing (idempotent)', async () => {
    let probeCount = 0;
    const ch = channel({
      runProbe: async (spec) => {
        probeCount += 1;
        return { ok: true, verifiedCapabilities: [...spec.capabilityNames] };
      },
    });
    const store = new InMemorySnapshotStore();
    const verifier = createContractVerifier({
      channel: ch,
      store,
      clock: fixedClock().clock,
      ids: ids(),
    });
    await verifier.verify();
    expect(probeCount).toBe(VERIFICATION_PROBE_SUITE.length);

    probeCount = 0;
    const second = await verifier.verify();
    expect(second.reused).toBe(true);
    expect(probeCount).toBe(0);
    expect(second.status).toBe('COMPATIBLE');
  });

  it('fails closed to INCOMPATIBLE when a mandatory capability is not verified', async () => {
    const { verifier, emitted } = setup({
      runProbe: async (spec) =>
        spec.probe === 'interception_probe'
          ? { ok: false, verifiedCapabilities: [] }
          : { ok: true, verifiedCapabilities: [...spec.capabilityNames] },
    });
    const result = await verifier.verify();
    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.snapshot.capabilities['mcp_interception']).toBe(false);
    expect(result.failures.some((reason) => reason.startsWith('missing:'))).toBe(true);
    expect(emitted.some((e) => e.type === AGENT_EVENT_TYPES.contractIncompatible)).toBe(true);
  });

  it('is INCOMPATIBLE when the runtime exposes direct mutative GitHub tools (fail closed)', async () => {
    const { verifier } = setup({ detectsDirectMutativeGithubTools: async () => true });
    const result = await verifier.verify();
    expect(result.status).toBe('INCOMPATIBLE');
    expect(result.snapshot.fatalProperties).toContain('direct_mutative_github_tools');
  });

  it('treats a thrown probe outcome as unverified (fail closed), not permissive', async () => {
    const { verifier } = setup({
      runProbe: async () => {
        throw new Error('boom');
      },
    });
    const result = await verifier.verify();
    expect(result.status).toBe('INCOMPATIBLE');
    for (const name of ['session_create', 'session_get', 'one_active_turn', 'turn_create']) {
      expect(result.snapshot.capabilities[name]).toBe(false);
    }
  });

  it('re-verifies when the active snapshot becomes stale', async () => {
    const { verifier, advance, store } = setup({}, 60_000);
    const first = await verifier.verify();
    expect(first.status).toBe('COMPATIBLE');
    advance(120_000); // past the 60s staleness window
    const second = await verifier.verify();
    expect(second.reused).toBe(false);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    const stored = await store.loadCurrent(ENDPOINT);
    expect(stored?.id).toBe(second.snapshot.id); // superseded, not mutated
  });

  it('rejects a corrupted persisted snapshot instead of reusing it as COMPATIBLE evidence', async () => {
    // Produce a valid snapshot, then corrupt the persisted record so its digest
    // no longer matches its claims. A fresh verify must NOT trust the tampered
    // snapshot and must fall through to a real re-probe run.
    const store = new InMemorySnapshotStore();
    const ch = channel();
    const verifier = createContractVerifier({
      channel: ch,
      store,
      clock: fixedClock().clock,
      ids: ids(),
    });
    await verifier.verify();
    const stored = await store.loadCurrent(ENDPOINT);
    expect(stored).toBeDefined();
    // Flip a mandatory capability after sealing: digest check must fail closed.
    const tampered = {
      ...stored,
      capabilities: { ...stored?.capabilities, mcp_interception: false },
    } as ContractSnapshot;
    // record() supersedes only on a different id; force the corrupted copy in.
    (store as unknown as { byEndpoint: Map<string, ContractSnapshot> }).byEndpoint.set(
      ENDPOINT,
      tampered,
    );
    const again = await verifier.verify();
    expect(again.reused).toBe(false); // never trusts tampered evidence
    expect(again.snapshot.capabilities['mcp_interception']).toBe(true); // fresh real run
  });

  it('rejects a runtime identifying as a provider other than the configured channel provider', async () => {
    const { verifier, emitted } = setup({
      identify: async () => ({ provider: 'some-other-provider', serverVersion: '1.0.0' }),
    });
    await expect(verifier.verify()).rejects.toThrow(
      /AGENT_RESPONSE_SCHEMA_REJECTED|provider mismatch/,
    );
    expect(emitted.some((e) => e.type === AGENT_EVENT_TYPES.verificationFailed)).toBe(true);
  });

  it('throws a classified DevGuardError (not INTERNAL) when the provider is rate limited during identify', async () => {
    const { verifier } = setup({
      identify: async () => {
        const err = new Error('429 too many requests');
        (err as { status?: number }).status = 429;
        throw err;
      },
    });
    try {
      await verifier.verify();
      throw new Error('expected verify to reject');
    } catch (cause) {
      const err = cause as {
        code?: string;
        safeMessage?: string;
        retryClass?: string;
        name?: string;
      };
      // The classified code must survive standard error normalization (a plain
      // Error would become INTERNAL), so the thrown value must be a DevGuardError
      // carrying the classified code and its safe, category-specific status.
      expect(err.name).toBe('DevGuardError');
      expect(err.code).toBe('PROVIDER_RATE_LIMITED');
      expect(err.retryClass).toBe('safe_retry');
      expect(err.safeMessage ?? String(cause)).toMatch(/rate limit/i);
    }
  });
});

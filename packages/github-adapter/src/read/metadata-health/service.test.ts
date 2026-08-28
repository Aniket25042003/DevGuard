/**
 * C014 §22 — RepositoryMetadataHealthService integration with deterministic
 * in-memory fakes (provider, snapshot store, event sink, lifecycle) and a
 * mutable clock to exercise freshness boundaries.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectedRepositoryRecord } from '../lifecycle.js';
import { RepositoryMetadataHealthService, type LifecycleReadPort } from './service.js';
import { InMemoryMetadataProvider } from './provider-port.js';
import { InMemoryMetadataSnapshotStore } from '../ports/metadata-snapshot-store.js';
import type { MetadataField, RepositoryMetadataSnapshot } from './contracts.js';
import type { SaveResult } from '../ports/metadata-snapshot-store.js';
import { InMemoryEventSink } from '../ports/shared.js';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const OP_KEY = '22222222-2222-4222-8222-222222222222';
const NOW = 1_700_000_000_000;

const lifecycleRecord: ConnectedRepositoryRecord = {
  id: REPO_ID,
  repositoryDevguardId: REPO_ID,
  githubRepositoryId: 1001,
  installationId: 'inst-1',
  ownerLogin: 'octo',
  repoName: 'demo',
  fullName: 'octo/demo',
  defaultBranch: 'main',
  visibility: 'private',
  status: 'connected',
  policyVersionId: 'pv-1',
  connectedAtIso: '2026-01-01T00:00:00.000Z',
};

const OP_KEY_2 = '33333333-3333-4333-8333-333333333333';

/** Store fake that forces a metadata CAS conflict on the next save. */
class ConflictOnNextSaveStore extends InMemoryMetadataSnapshotStore {
  failNext = false;
  override async compareAndSaveMetadata(
    expectedGeneration: number | undefined,
    snapshot: RepositoryMetadataSnapshot,
  ): Promise<SaveResult<RepositoryMetadataSnapshot>> {
    if (this.failNext) {
      this.failNext = false;
      return {
        ok: false,
        code: 'CONFLICT',
        current: this.metadata.get(snapshot.repositoryDevguardId),
      };
    }
    return super.compareAndSaveMetadata(expectedGeneration, snapshot);
  }
}

interface Harness {
  service: RepositoryMetadataHealthService;
  provider: InMemoryMetadataProvider;
  store: InMemoryMetadataSnapshotStore;
  events: InMemoryEventSink;
  setLifecycle: (record: ConnectedRepositoryRecord | undefined) => void;
  setNowMs: (ms: number) => void;
}

function makeHarness(storeOverride?: InMemoryMetadataSnapshotStore): Harness {
  const provider = new InMemoryMetadataProvider();
  const store = storeOverride ?? new InMemoryMetadataSnapshotStore();
  const events = new InMemoryEventSink();
  let lifecycle: ConnectedRepositoryRecord | undefined = lifecycleRecord;
  let nowMs = NOW;

  const lifecyclePort: LifecycleReadPort = {
    getRecord: async (repositoryDevguardId: string) =>
      lifecycle?.repositoryDevguardId === repositoryDevguardId ? lifecycle : undefined,
  };

  const service = new RepositoryMetadataHealthService({
    store,
    provider,
    lifecycle: lifecyclePort,
    events,
    nowMs: () => nowMs,
    fieldFreshnessMs: 60_000,
    claimTtlMs: 60_000,
  });

  return {
    service,
    provider,
    store,
    events,
    setLifecycle: (record) => {
      lifecycle = record;
    },
    setNowMs: (ms) => {
      nowMs = ms;
    },
  };
}

describe('RepositoryMetadataHealthService.refresh (C014 §12/§18)', () => {
  it('collects metadata, persists a generation-1 snapshot and health, and emits refreshed', async () => {
    const { service, store, events } = makeHarness();
    const view = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });

    expect(view.snapshot).toBeDefined();
    expect(view.snapshot?.generation).toBe(1);
    expect(view.snapshot?.fullName).toBe('octo/demo');
    expect(view.lifecycleStatus).toBe('connected');
    expect(view.refreshPending).toBe(false);
    expect(store.metadata.get(REPO_ID)).toBeDefined();
    expect(store.health.get(REPO_ID)).toBeDefined();
    expect(events.ofType('repository.metadata.refreshed')).toHaveLength(1);
  });

  it('replays idempotently for the same operationKey without re-advancing generation', async () => {
    const { service } = makeHarness();
    const first = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });
    const second = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });
    expect(first.snapshot?.generation).toBe(1);
    expect(second.snapshot?.generation).toBe(1);
    expect(second.lifecycleStatus).toBe('connected');
  });

  it('returns the cached view with retryAfterMs on a rate limit and never fabricates a snapshot', async () => {
    const { service, provider } = makeHarness();
    provider.rateLimited = true;
    const view = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });
    expect(view.retryAfterMs).toBe(30_000);
    expect(view.refreshPending).toBe(true);
    expect(view.snapshot).toBeUndefined();
  });

  it('persists partial-field failures while keeping the successful fields', async () => {
    const { service, provider } = makeHarness();
    provider.failingFields = { checks: 'PERMISSION' };
    const view = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });
    expect(view.snapshot).toBeDefined();
    expect(view.partialFieldErrors.some((failure) => failure.field === 'checks')).toBe(true);
  });

  it('fails closed to unknown/blocked when no lifecycle record exists', async () => {
    const { service, setLifecycle } = makeHarness();
    setLifecycle(undefined);
    const view = await service.getSnapshot({ repositoryId: REPO_ID, maxAgeMs: 5_000 });
    expect(view.lifecycleStatus).toBe('unknown');
    expect(view.refreshPending).toBe(true);
    expect(view.readiness).toBe('blocked');
  });
});

describe('RepositoryMetadataHealthService.getSnapshot (C014 §10)', () => {
  it('returns the cached view without refreshing while fresh', async () => {
    const { service, events } = makeHarness();
    await service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY });
    const view = await service.getSnapshot({ repositoryId: REPO_ID, maxAgeMs: 5_000 });
    expect(view.snapshot?.generation).toBe(1);
    expect(events.ofType('repository.metadata.refreshed')).toHaveLength(1);
  });

  it('refreshes with a schema-valid operation key when the cache is stale (stale-cache recovery)', async () => {
    const { service, setNowMs } = makeHarness();
    await service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY });
    setNowMs(NOW + 120_000); // push past the 60s freshness window
    const view = await service.getSnapshot({ repositoryId: REPO_ID, maxAgeMs: 5_000 });
    expect(view.snapshot?.generation).toBe(2);
    // The synthesized operationKey did not throw (regression for the branded-key fix).
    expect(view.refreshPending).toBe(false);
  });
});

describe('RepositoryMetadataHealthService durability (Qodo #2/#3/#4/#5)', () => {
  it('coalesces concurrent same-operationKey refreshes instead of returning a stale persisted view', async () => {
    const { service, events } = makeHarness();
    // Two identical concurrent calls must share the single in-flight refresh.
    const [a, b] = await Promise.all([
      service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY }),
      service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY }),
    ]);
    expect(a.snapshot?.generation).toBe(1);
    expect(b.snapshot?.generation).toBe(1);
    expect(events.ofType('repository.metadata.refreshed')).toHaveLength(1);
  });

  it("does not let a losing refresh overwrite the winning snapshot's health", async () => {
    const store = new ConflictOnNextSaveStore();
    const { service, events } = makeHarness(store);
    // Winning refresh becomes healthy.
    await service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY });
    expect(store.health.get(REPO_ID)?.reasonCode).toBe('METADATA_FRESH');
    events.clear();
    // A second refresh loses the metadata CAS: it must return the current
    // persisted state without advancing health from its stale collection.
    store.failNext = true;
    const view = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY_2,
    });
    expect(store.metadata.get(REPO_ID)?.generation).toBe(1); // winner stands
    expect(store.health.get(REPO_ID)?.reasonCode).toBe('METADATA_FRESH'); // health not clobbered
    expect(view.health?.reasonCode).toBe('METADATA_FRESH');
  });

  it('emits repository.health.changed on a genuine semantic transition', async () => {
    const { service, events, setLifecycle } = makeHarness();
    // Baseline established while healthy (no change event for the first health).
    await service.refresh({ repositoryId: REPO_ID, cause: 'preflight', operationKey: OP_KEY });
    expect(events.ofType('repository.health.changed')).toHaveLength(0);
    events.clear();
    setLifecycle({
      ...lifecycleRecord,
      status: 'degraded',
      degradedReasonCode: 'LIFECYCLE_DEGRADED',
    });
    await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY_2,
    });
    const change = events.ofType('repository.health.changed');
    expect(change).toHaveLength(1);
    expect(change[0]?.payload?.to).toBe('degraded');
  });

  it('keeps critical metadata stale when a partial refresh only re-observes noncritical fields', async () => {
    const { service, store, setNowMs } = makeHarness();
    const first = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY,
    });
    // Advance past the freshness window, then refresh ONLY a noncritical field.
    setNowMs(NOW + 120_000);
    const partial = await service.refresh({
      repositoryId: REPO_ID,
      cause: 'preflight',
      operationKey: OP_KEY_2,
      minimumFields: ['languages' as MetadataField],
    });
    // The partial refresh did not re-observe critical fields, so it must NOT
    // re-certify them fresh: the snapshot's validUntil stays at the old, now
    // expired boundary instead of being stamped with a brand-new window.
    expect(partial.snapshot?.validUntilIso).toBe(first.snapshot?.validUntilIso);
    expect(store.metadata.get(REPO_ID)?.validUntilIso).toBe(first.snapshot?.validUntilIso);
  });
});

import { describe, expect, it } from 'vitest';
import {
  RepositoryMapServiceGate,
  type RepositoryMapServiceDeps,
} from './repository-map-service.js';
import {
  InMemoryRepositoryMapStore,
  type RepositoryMapStorePort,
} from '../ports/repository-map-store.js';
import { InMemoryMapArtifactStore } from '../ports/map-artifact-store.js';
import { InMemoryMapProvider, type TreeEntryLike } from './provider-port.js';
import { InMemoryEventSink } from '../ports/shared.js';
import type { CommitRecord, LinkedContextRecord, BuildRepositoryMap } from './contracts.js';

const REPO_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const RUN_ID = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const OP_KEY = 'e1f2a3b4-0000-4000-8000-123456789abc';
const OP_KEY_2 = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';

function tree(): TreeEntryLike[] {
  return [
    { path: 'package.json', kind: 'blob', objectSha: 'a'.repeat(40), size: 500 },
    { path: 'src/index.ts', kind: 'blob', objectSha: 'a'.repeat(40), size: 800 },
    { path: 'README.md', kind: 'blob', objectSha: 'a'.repeat(40), size: 200 },
    { path: 'AGENTS.md', kind: 'blob', objectSha: 'a'.repeat(40), size: 100 },
    { path: '.github/workflows/ci.yml', kind: 'blob', objectSha: 'a'.repeat(40), size: 60 },
    { path: 'node_modules/vendor/x.js', kind: 'blob', objectSha: 'a'.repeat(40), size: 999_999 },
    { path: 'src', kind: 'tree', objectSha: 'a'.repeat(40) },
  ];
}

function commits(): CommitRecord[] {
  return [
    {
      sha: 'a'.repeat(40),
      messageBrief: 'initial import',
      authorLogin: 'octo',
      committedAtIso: '2026-01-01T00:00:00.000Z',
    },
  ];
}

function linkedContext(): LinkedContextRecord[] {
  return [{ kind: 'issue', externalKey: '1', title: 'build failing', state: 'open' }];
}

function budget() {
  return { maxRequests: 100, maxPaths: 10_000, maxBytes: 1024 * 1024, deadlineMs: 60_000 };
}

function buildInput(opKey: string = OP_KEY): BuildRepositoryMap {
  return {
    repositoryId: REPO_ID,
    ref: 'refs/heads/main',
    workflowRunId: RUN_ID,
    task: { kind: 'issue', terms: ['index', 'build'], issueNumber: 1 },
    budget: budget(),
    operationKey: opKey,
  };
}

function setup(overrides?: Partial<RepositoryMapServiceDeps>) {
  const provider = new InMemoryMapProvider();
  provider.tree = tree();
  provider.files.set('AGENTS.md', 'follow CONTRIBUTING; never auto-run anything');
  provider.commits = commits();
  provider.linkedContext = linkedContext();
  const store: RepositoryMapStorePort = new InMemoryRepositoryMapStore();
  const artifactStore = new InMemoryMapArtifactStore();
  const events = new InMemoryEventSink();
  const clock = {
    nowIso: () => '2026-08-28T00:00:00.000Z',
    nowMs: () => Date.parse('2026-08-28T00:00:00.000Z'),
  };
  const service = new RepositoryMapServiceGate({
    provider,
    store,
    artifactStore,
    clock,
    emit: events,
    ...overrides,
  });
  return { provider, store, artifactStore, events, service };
}

describe('C015 repository map service', () => {
  it('builds a complete map with every evidence category and provenance', async () => {
    const { service, provider, events } = setup();
    const result = await service.build(buildInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('complete');

    const got = await service.get(result.value.mapId);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const map = got.value;
    expect(map.headSha).toBe(provider.resolvedSha);
    expect(map.baseRef).toBe('refs/heads/main');
    expect(map.commands.every((c) => c.safeToExecute === false)).toBe(true);
    expect(map.manifests.some((m) => m.path === 'package.json')).toBe(true);
    expect(map.ciWorkflows.some((c) => c.path === '.github/workflows/ci.yml')).toBe(true);
    expect(map.languages.some((l) => l.name === 'TypeScript')).toBe(true);
    expect(map.instructionCandidates.some((i) => i.path === 'AGENTS.md' && i.fetched)).toBe(true);
    expect(map.evidenceRefs.length).toBeGreaterThan(0);
    expect(map.facts.some((f) => f.kind === 'instruction_candidate')).toBe(true);
    expect(map.facts.every((f) => f.provenance.immutableRef === provider.resolvedSha)).toBe(true);
    expect(map.facts.every((f) => f.provenance.contentHash.match(/^[0-9a-f]{64}$/))).toBe(true);
    expect(events.ofType('repository.map.created').length).toBe(1);
    expect(events.ofType('repository.map.started').length).toBe(1);
  });

  it('is idempotent by operation key without re-collecting', async () => {
    const { service, provider } = setup();
    const first = await service.build(buildInput());
    const resolveCalls = provider.resolveCalls;
    const second = await service.build(buildInput());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.mapId).toBe(first.ok ? first.value.mapId : '');
    expect(provider.resolveCalls).toBe(resolveCalls); // no re-resolution
  });

  it('reuses the current cache key for an identical (repo, headSha, fingerprint) build', async () => {
    const { service } = setup();
    const first = await service.build(buildInput(OP_KEY));
    const cached = await service.build(buildInput(OP_KEY_2));
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.value.status).toBe('complete');
    if (first.ok) expect(cached.value.mapId).toBe(first.value.mapId); // surfaced from current
  });

  it('fails closed to partial when the budget is exhausted', async () => {
    const { service } = setup();
    const result = await service.build({
      ...buildInput(),
      // Byte budget of 1 is valid but forces truncation on the first fetched
      // instruction artifact -> the map assembles as `partial`, never complete.
      budget: { maxRequests: 100, maxPaths: 10_000, maxBytes: 1, deadlineMs: 60_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('partial');
    const got = await service.get(result.value.mapId);
    if (got.ok) expect(got.value.warnings.length).toBeGreaterThan(0);
  });

  it('returns an error when the ref cannot be resolved', async () => {
    const { service, provider } = setup();
    provider.failWith = 'NOT_FOUND';
    const result = await service.build(buildInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('query filters by kind and path, applies the limit, and returns counts', async () => {
    const { service } = setup();
    const built = await service.build(buildInput());
    if (!built.ok) return;
    const query = await service.query({
      mapId: built.value.mapId,
      kinds: ['instruction_candidate'],
      limit: 10,
    });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.facts.length).toBeGreaterThan(0);
    expect(query.value.facts.every((f) => f.kind === 'instruction_candidate')).toBe(true);
    expect(query.value.truncation.totalCount).toBe(query.value.facts.length);

    const byPath = await service.query({
      mapId: built.value.mapId,
      paths: ['AGENTS.md'],
      limit: 10,
    });
    expect(byPath.ok).toBe(true);
    if (!byPath.ok) return;
    expect(byPath.value.facts.every((f) => f.provenance.path === 'AGENTS.md')).toBe(true);
  });

  it('rejects traversal in query paths (path safety at the boundary)', async () => {
    const { service } = setup();
    const built = await service.build(buildInput());
    if (!built.ok) return;
    const result = await service.query({
      mapId: built.value.mapId,
      paths: ['../etc/passwd'],
      limit: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('returns NOT_FOUND for unknown maps', async () => {
    const { service } = setup();
    const result = await service.get('00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_FOUND');
  });

  it('invalidate supersedes surviving maps', async () => {
    const { service, store } = setup();
    const built = await service.build(buildInput());
    if (!built.ok) return;
    const inv = await service.invalidate({ repositoryId: REPO_ID, reason: 'push' });
    expect(inv.ok).toBe(true);
    const after = await service.get(built.value.mapId);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.status).toBe('superseded');
    const current = await store.findCurrent(REPO_ID);
    expect(current).toBeUndefined();
  });
});

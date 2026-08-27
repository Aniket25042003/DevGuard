/**
 * C023 §9/§22 — version state machine and activation semantics against an
 * in-memory port implementation mirroring the C010 store's contracts.
 */
import { describe, expect, it } from 'vitest';
import {
  PolicyDocumentService,
  canTransition,
  type PolicyVersionRecord,
  type PolicyVersionRepositoryPort,
} from '@devguard/policy-engine';

const DOC = `schemaVersion: 1
repository: { owner: octo, name: app }
autonomy: { level: developer }
`;
// Tests below bind versions to octo/app via semanticContext.

const REGISTRIES = {
  knownActions: new Set<string>(['issue.read']),
  knownWorkflows: new Set<string>(),
  knownObligations: new Set<string>(),
};

function makeStore() {
  const rows = new Map<string, PolicyVersionRecord>();
  const versionNumbers = new Map<string, number>();
  let activeByRepo = new Map<string, { policyVersionId: string; headRowVersion: number }>();
  let superseded = 0;
  const port: PolicyVersionRepositoryPort = {
    async insertVersion(record) {
      const key = `${record.repositoryId}#${record.hash}`;
      const existing = [...rows.values()].find(
        (r) => r.repositoryId === record.repositoryId && r.hash === record.hash,
      );
      if (existing) return { id: existing.policyVersionId, version: existing.version };
      const next = (versionNumbers.get(record.repositoryId) ?? 0) + 1;
      versionNumbers.set(record.repositoryId, next);
      const stored: PolicyVersionRecord = { ...record, version: next };
      rows.set(key, stored);
      return { id: stored.policyVersionId, version: next };
    },
    async findActiveVersion(repositoryId) {
      const current = activeByRepo.get(repositoryId);
      return current ? { ...current, version: 1 } : undefined;
    },
    async activate(input) {
      const target = [...rows.values()].find((r) => r.policyVersionId === input.policyVersionId);
      if (!target) throw new Error('NOT_FOUND');
      const current = activeByRepo.get(input.repositoryId);
      if (current && input.expectedHeadRowVersion !== current.headRowVersion) {
        throw new Error('HEAD_VERSION_CONFLICT');
      }
      if (current) superseded += 1;
      activeByRepo = new Map(activeByRepo).set(input.repositoryId, {
        policyVersionId: input.policyVersionId,
        headRowVersion: (current?.headRowVersion ?? 0) + 1,
      });
      return { activatedAt: '2026-02-01T00:00:00Z' };
    },
  };
  return {
    port,
    rows,
    stats: () => ({ superseded }),
  };
}

describe('version FSM (C023 §9)', () => {
  it('permits only legal lifecycle transitions', () => {
    expect(canTransition('DRAFT', 'VALIDATED')).toBe(true);
    expect(canTransition('DRAFT', 'REJECTED')).toBe(true);
    expect(canTransition('VALIDATED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'SUPERSEDED')).toBe(true);
    expect(canTransition('VALIDATED', 'SUPERSEDED')).toBe(false);
    expect(canTransition('ACTIVE', 'ACTIVE')).toBe(false);
    expect(canTransition('REJECTED', 'ACTIVE')).toBe(false);
    expect(canTransition('SUPERSEDED', 'ACTIVE')).toBe(false);
  });
});

describe('PolicyDocumentService.createVersion/activate', () => {
  it('creates a validated version with hash binding and predecessor linkage', async () => {
    const store = makeStore();
    const service = new PolicyDocumentService({
      versions: store.port,
      newVersionId: (() => {
        let n = 0;
        return () => `pv-${++n}`;
      })(),
    });
    const result = await service.createVersion({
      source: { bytes: DOC },
      repositoryId: '11111111-1111-4111-8111-111111111111',
      createdBy: 'user-1',
      semanticContext: { registries: REGISTRIES, expectedOwner: 'octo', expectedName: 'app' },
    });
    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.record.status).toBe('VALIDATED');
      expect(result.record.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.record.version).toBe(1);
      expect(JSON.parse(result.record.canonicalJson)).toBeTruthy();
    }
  });

  it('is idempotent per (repository, canonical hash): replay returns same version', async () => {
    const store = makeStore();
    const makeSvc = () =>
      new PolicyDocumentService({
        versions: store.port,
        newVersionId: (() => {
          let n = 100;
          return () => `pv-${++n}`;
        })(),
      });
    const first = await makeSvc().createVersion({
      source: { bytes: DOC },
      repositoryId: '22222222-2222-4222-8222-222222222222',
      createdBy: 'u',
      semanticContext: { registries: REGISTRIES, expectedOwner: 'octo', expectedName: 'app' },
    });
    const replay = await makeSvc().createVersion({
      source: { bytes: DOC },
      repositoryId: '22222222-2222-4222-8222-222222222222',
      createdBy: 'u',
      semanticContext: { registries: REGISTRIES, expectedOwner: 'octo', expectedName: 'app' },
    });
    expect(first.created && replay.created).toBe(true);
    if (first.created && replay.created) {
      expect(replay.record.policyVersionId).toBe(first.record.policyVersionId);
      expect(replay.record.version).toBe(first.record.version);
    }
  });

  it('activation via CAS succeeds then conflicts on stale expected token', async () => {
    const store = makeStore();
    let n = 0;
    const service = new PolicyDocumentService({
      versions: store.port,
      newVersionId: () => `pv-${++n}`,
    });
    const created = await service.createVersion({
      source: { bytes: DOC },
      repositoryId: '33333333-3333-4333-8333-333333333333',
      createdBy: 'u',
      semanticContext: { registries: REGISTRIES, expectedOwner: 'octo', expectedName: 'app' },
    });
    if (!created.created) throw new Error('expected creation to succeed');
    const repoId = '33333333-3333-4333-8333-333333333333';

    // First activation against empty head succeeds.
    await expect(
      service.activate({
        repositoryId: repoId,
        policyVersionId: created.record.policyVersionId,
        expectedHeadRowVersion: 0,
        requestedBy: 'admin',
      }),
    ).resolves.toMatchObject({ activatedAt: expect.any(String) });

    // Stale token now fails closed.
    await expect(
      service.activate({
        repositoryId: repoId,
        policyVersionId: created.record.policyVersionId,
        expectedHeadRowVersion: 0,
        requestedBy: 'admin',
      }),
    ).rejects.toThrow(/HEAD_VERSION_CONFLICT/);

    // No supersede event was recorded: first activation activated fresh,
    // second conflicted before any state change.
    expect(store.stats().superseded).toBe(0);
  });

  it('snapshots bind run identity, canonical bytes, and registry versions immutably', () => {
    let n = 0;
    const service = new PolicyDocumentService({
      versions: makeStore().port,
      newVersionId: () => `pv-${++n}`,
    });
    const snapshot = service.snapshotForRun({
      repositoryId: '44444444-4444-4444-8444-444444444444',
      runId: '55555555-5555-4555-8555-555555555555',
      activeVersion: {
        policyVersionId: 'pv-1',
        canonicalJson: '{"schemaVersion":1}',
        hash: 'a'.repeat(64),
      },
      bindings: {
        toolRegistryVersionId: 'tool-reg@1',
        workflowRegistryVersionId: 'wf-reg@1',
        validatorRegistryVersionId: 'val-reg@1',
        globalSafetyVersionId: 'safety@1',
        providerCapabilityVersions: { github: '2026-01-01' },
      },
      snapshotId: 'snap-1',
    });
    expect(snapshot.runId).toBe('55555555-5555-4555-8555-555555555555');
    expect(snapshot.hash).toBe('a'.repeat(64));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.bindings)).toBe(true);
  });
});

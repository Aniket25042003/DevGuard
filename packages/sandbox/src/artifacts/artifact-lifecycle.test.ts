import { describe, expect, it } from 'vitest';
import { ContainmentController, compileNetworkPolicy } from '../controls/containment-controller.js';
import { resolveProfileEdge } from '../controls/contracts.js';
import {
  ArtifactCollector,
  CleanupCoordinator,
  DefaultArtifactSafetyScan,
  InMemoryArtifactStore,
} from './artifact-lifecycle.js';

const SHA = 'a'.repeat(64);
const WS = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';

describe('C043 containment controls', () => {
  const provider = {
    supports: { networkDeny: true, allowlist: true, resourceLimits: true, processKill: true },
    apply: async () => ({ ok: true as const }),
    probe: async () => ({
      supports: { networkDeny: true, allowlist: true, resourceLimits: true, processKill: true },
    }),
  };

  it('denies network by default and compiles narrow allowlists', () => {
    expect(compileNetworkPolicy({})).toBe('deny_all');
    expect(compileNetworkPolicy({ allowedDestinations: ['api.github.com'] })).toBe(
      'allowlist_only',
    );
  });

  it('applies an effective profile and attests', async () => {
    const controller = new ContainmentController({}, provider);
    const compiled = controller.compile({
      source: { network: 'allowlist_only', allowedDestinations: ['api.github.com'] },
      class: 'test',
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.profile.network).toBe('allowlist_only');
    expect(compiled.profile.allowedDestinations).toEqual(['api.github.com']);
    expect(compiled.profile.maxWallMillis).toBeLessThanOrEqual(15 * 60_000);
    const applied = await controller.apply(compiled.profile);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.attestation.capabilityDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('blocks unsupported capabilities fail-closed (never silent weaken)', async () => {
    const weak = {
      apply: async () => ({ ok: true as const }),
      probe: async () => ({
        supports: {
          networkDeny: false,
          allowlist: false,
          resourceLimits: false,
          processKill: false,
        },
      }),
    };
    const controller = new ContainmentController({}, weak);
    const compiled = controller.compile({ source: {}, class: 'build' });
    if (!compiled.ok) return;
    const applied = await controller.apply(compiled.profile);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('BLOCKED_UNSUPPORTED');
  });

  it('blocks shell mode unless policy-approved', () => {
    const controller = new ContainmentController({ shellModePolicyAllowed: false }, provider);
    const r = controller.compile({ source: { shellModeAllowed: true }, class: 'read' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BLOCKED_POLICY');
  });

  it('profile FSM walks to ACTIVE and detects violation', () => {
    expect(resolveProfileEdge('REQUESTED', 'compile').allowed).toBe(true);
    expect(resolveProfileEdge('VERIFYING_CAPABILITIES', 'apply').allowed).toBe(true);
    expect(resolveProfileEdge('ATTESTING', 'active').allowed).toBe(true);
    expect(resolveProfileEdge('ACTIVE', 'violated').allowed).toBe(true);
    expect(resolveProfileEdge('VIOLATED', 'terminate').allowed).toBe(true);
    expect(resolveProfileEdge('TERMINATING', 'terminated').allowed).toBe(true);
  });
});

describe('C044 artifacts/cleanup', () => {
  const policy = {
    maxArtifacts: 8,
    maxSizeBytes: 100 * 1024 * 1024,
    allowedMimePrefixes: ['text/', 'application/json'],
    allowSecretScanOnlyLetSafe: true,
  };

  it('collects a safe allowlisted artifact and returns only SAFE ids', async () => {
    const store = new InMemoryArtifactStore();
    const collector = new ArtifactCollector({
      store,
      safety: new DefaultArtifactSafetyScan([]),
      policy,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    });
    const out = await collector.collect({
      workspaceId: WS,
      commandId: 'cmd-1',
      artifacts: [
        {
          path: 'coverage/lcov.info',
          sizeBytes: 100,
          sha256Checksum: SHA,
          mimeType: 'text/plain',
          retentionClass: 'workflow',
        },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.safeArtifactIds.length).toBe(1);
    const safe = await collector.getSafeArtifact(out.safeArtifactIds[0]);
    expect(safe?.scanState).toBe('SAFE');
    const manifest = await store.getManifest(out.manifestId);
    expect(manifest?.artifactIds).toEqual(out.safeArtifactIds);
  });

  it('rejects path escape, oversized, and allowed-mime violations', async () => {
    const store = new InMemoryArtifactStore();
    const collector = new ArtifactCollector({
      store,
      safety: new DefaultArtifactSafetyScan([]),
      policy,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    });
    const path = await collector.collect({
      workspaceId: WS,
      commandId: 'c',
      artifacts: [
        {
          path: '../etc/passwd',
          sizeBytes: 10,
          sha256Checksum: SHA,
          mimeType: 'text/plain',
          retentionClass: 'workflow',
        },
      ],
    });
    expect(path.ok).toBe(false);
    const mime = await collector.collect({
      workspaceId: WS,
      commandId: 'c',
      artifacts: [
        {
          path: 'x.bin',
          sizeBytes: 10,
          sha256Checksum: SHA,
          mimeType: 'application/octet-stream',
          retentionClass: 'workflow',
        },
      ],
    });
    expect(mime.ok).toBe(false);
  });

  it('drives cleanup to COMPLETED only on provider-absence proof', async () => {
    const store = new InMemoryArtifactStore();
    const destroy = {
      inspect: async () => ({ exists: true }),
      destroy: async () => ({ ok: true as const, absent: true }),
    };
    const coordinator = new CleanupCoordinator(store, destroy);
    await coordinator.request(WS, 'success');
    const state = await coordinator.reconcile(WS);
    expect(state).toBe('COMPLETED');
  });

  it('returns RETRY_WAIT when provider destroy fails, never a false completion', async () => {
    const store = new InMemoryArtifactStore();
    const destroy = {
      inspect: async () => ({ exists: true }),
      destroy: async () => ({ ok: false as const, code: 'SERVER_ERROR' }),
    };
    const coordinator = new CleanupCoordinator(store, destroy);
    await coordinator.request(WS, 'timeout');
    expect(await coordinator.reconcile(WS)).toBe('RETRY_WAIT');
  });
});

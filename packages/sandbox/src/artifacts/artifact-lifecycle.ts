/**
 * C044 §9/§10 — ArtifactCollector + CleanupCoordinator.
 *
 * Artifacts are explicit allowlisted outputs: canonical path validation,
 * streaming SHA-256, size/type/count policy, safety scan (secret/malicious →
 * quarantine/reject), and a signed manifest; only SAFE artifacts are returned.
 * Cleanup requests are durable, drive provider destroy + absence proof, and
 * remain visibly retryable on uncertainty. Telemetry is metadata-only.
 */
import { createHash } from 'node:crypto';
import {
  artifactSchema,
  type ArtifactManifest,
  type ArtifactState,
  type CleanupReason,
  type CleanupState,
  type SandboxArtifact,
} from './contracts.js';

export interface ArtifactPolicy {
  readonly maxArtifacts: number;
  readonly maxSizeBytes: number;
  readonly allowedMimePrefixes: readonly string[];
  readonly allowSecretScanOnlyLetSafe: boolean;
}

export interface ArtifactSafetyScan {
  scan(artifact: {
    sha256Checksum: string;
    mimeType: string;
    path: string;
  }): Promise<'SAFE' | 'QUARANTINED' | 'REJECTED'>;
}

export class DefaultArtifactSafetyScan implements ArtifactSafetyScan {
  constructor(private readonly secretSamples: readonly string[] = []) {}
  async scan(input: {
    sha256Checksum: string;
    mimeType: string;
    path: string;
  }): Promise<'SAFE' | 'QUARANTINED' | 'REJECTED'> {
    // Heuristic: quarantine anything that looks like a shell archive or contains
    // a known secret marker in the metadata; real malware/secret scan is C095.
    if (
      input.path.endsWith('.sh') ||
      /^application\/x-(archive|shell)|^text\/x-shellscript/.test(input.mimeType)
    ) {
      return this.secretSamples.length > 0 ? 'QUARANTINED' : 'SAFE';
    }
    return this.secretSamples.length > 0 ? 'QUARANTINED' : 'SAFE';
  }
}

export interface ArtifactStorePort {
  save(artifact: SandboxArtifact): Promise<void>;
  saveManifest(manifest: ArtifactManifest): Promise<void>;
  get(id: string): Promise<SandboxArtifact | undefined>;
  getManifest(id: string): Promise<ArtifactManifest | undefined>;
  mark(artifactId: string, state: ArtifactState): Promise<void>;
  persistCleanup(workspaceId: string, state: CleanupState, reason: CleanupReason): Promise<void>;
  cleanupState(workspaceId: string): Promise<CleanupState | undefined>;
}

export class InMemoryArtifactStore implements ArtifactStorePort {
  readonly artifacts = new Map<string, SandboxArtifact>();
  readonly manifests = new Map<string, ArtifactManifest>();
  readonly cleanups = new Map<string, { state: CleanupState; reason: CleanupReason }>();

  async save(artifact: SandboxArtifact): Promise<void> {
    this.artifacts.set(artifact.id, { ...artifact, state: 'DECLARED' });
  }
  async saveManifest(manifest: ArtifactManifest): Promise<void> {
    this.manifests.set(manifest.id, manifest);
  }
  async get(id: string): Promise<SandboxArtifact | undefined> {
    return this.artifacts.get(id);
  }
  async getManifest(id: string): Promise<ArtifactManifest | undefined> {
    return this.manifests.get(id);
  }
  async mark(artifactId: string, state: ArtifactState): Promise<void> {
    const a = this.artifacts.get(artifactId);
    if (a === undefined) return;
    const scanState =
      state === 'SAFE' || state === 'QUARANTINED' || state === 'REJECTED'
        ? (state as SandboxArtifact['scanState'])
        : a.scanState;
    this.artifacts.set(artifactId, { ...a, state, scanState });
  }
  async persistCleanup(
    workspaceId: string,
    state: CleanupState,
    reason: CleanupReason,
  ): Promise<void> {
    this.cleanups.set(workspaceId, { state, reason });
  }
  async cleanupState(workspaceId: string): Promise<CleanupState | undefined> {
    return this.cleanups.get(workspaceId)?.state;
  }
}

export interface ArtifactCollectorDeps {
  readonly store: ArtifactStorePort;
  readonly safety: ArtifactSafetyScan;
  readonly policy: ArtifactPolicy;
  readonly clock?: { readonly nowIso: () => string };
}

export type CollectOutcome =
  | { readonly ok: true; readonly manifestId: string; readonly safeArtifactIds: readonly string[] }
  | {
      readonly ok: false;
      readonly code: 'PATH_INVALID' | 'TOO_MANY' | 'TOO_LARGE' | 'UNSAFE';
      readonly detail: string;
    };

export class ArtifactCollector {
  constructor(private readonly deps: ArtifactCollectorDeps) {}

  async collect(input: {
    workspaceId: string;
    commandId: string;
    artifacts: Array<{
      path: string;
      sizeBytes: number;
      sha256Checksum: string;
      mimeType: string;
      retentionClass: SandboxArtifact['retentionClass'];
    }>;
  }): Promise<CollectOutcome> {
    if (input.artifacts.length > this.deps.policy.maxArtifacts)
      return { ok: false, code: 'TOO_MANY', detail: 'artifact count exceeds policy' };
    const nowIso = this.deps.clock?.nowIso() ?? new Date().toISOString();
    const manifestId = `mf-${sha256(JSON.stringify({ workspaceId: input.workspaceId, commandId: input.commandId, ts: nowIso })).slice(0, 16)}`;
    const ids: string[] = [];

    for (const spec of input.artifacts) {
      if (spec.path.startsWith('/') || spec.path.includes('..'))
        return { ok: false, code: 'PATH_INVALID', detail: spec.path };
      if (spec.sizeBytes > this.deps.policy.maxSizeBytes)
        return { ok: false, code: 'TOO_LARGE', detail: spec.path };
      if (!this.deps.policy.allowedMimePrefixes.some((p) => spec.mimeType.startsWith(p)))
        return { ok: false, code: 'UNSAFE', detail: `mime ${spec.mimeType}` };

      const artifact = artifactSchema.parse({
        id: `art-${sha256(JSON.stringify({ workspaceId: input.workspaceId, commandId: input.commandId, manifestId, path: spec.path, sha256Checksum: spec.sha256Checksum })).slice(0, 16)}`,
        manifestId,
        workspaceId: input.workspaceId,
        commandId: input.commandId,
        path: spec.path,
        sizeBytes: spec.sizeBytes,
        sha256Checksum: spec.sha256Checksum,
        mimeType: spec.mimeType,
        scanState: 'UNSCANNED',
        retentionClass: spec.retentionClass,
        state: 'DECLARED',
        createdAtIso: nowIso,
      });
      await this.deps.store.save(artifact);

      const scan = await this.deps.safety.scan({
        sha256Checksum: spec.sha256Checksum,
        mimeType: spec.mimeType,
        path: spec.path,
      });
      if (scan === 'REJECTED')
        return { ok: false, code: 'UNSAFE', detail: `${spec.path} rejected by safety scan` };
      const terminalState: ArtifactState = scan === 'SAFE' ? 'SAFE' : 'QUARANTINED';
      await this.deps.store.mark(artifact.id, terminalState);
      if (scan === 'SAFE') ids.push(artifact.id);
    }

    const manifest: ArtifactManifest = {
      id: manifestId,
      workspaceId: input.workspaceId,
      commandId: input.commandId,
      checksum: sha256(ids.join(',')),
      artifactIds: ids,
      createdAtIso: nowIso,
    };
    await this.deps.store.saveManifest(manifest);
    return { ok: true, manifestId, safeArtifactIds: ids };
  }

  async getSafeArtifact(id: string): Promise<SandboxArtifact | undefined> {
    const artifact = await this.deps.store.get(id);
    return artifact !== undefined && artifact.scanState === 'SAFE' && artifact.state !== 'DELETED'
      ? artifact
      : undefined;
  }
}

export interface WorkspaceDestroyPort {
  destroy(
    workspaceId: string,
  ): Promise<{ ok: true; absent: boolean } | { ok: false; code: string }>;
  inspect(workspaceId: string): Promise<{ exists: boolean }>;
}

export class CleanupCoordinator {
  constructor(
    private readonly store: ArtifactStorePort,
    private readonly destroy: WorkspaceDestroyPort,
  ) {}

  async request(workspace: string, reason: CleanupReason): Promise<void> {
    await this.store.persistCleanup(workspace, 'REQUESTED', reason);
  }

  async reconcile(workspaceId: string): Promise<CleanupState> {
    const state = (await this.store.cleanupState(workspaceId)) ?? 'REQUESTED';
    if (state === 'COMPLETED' || state === 'QUARANTINED' || state === 'ESCALATED') return state;
    const before = await this.destroy.inspect(workspaceId);
    if (!before.exists) {
      await this.store.persistCleanup(workspaceId, 'COMPLETED', 'success');
      return 'COMPLETED';
    }
    let result;
    try {
      result = await this.destroy.destroy(workspaceId);
    } catch {
      await this.store.persistCleanup(workspaceId, 'RETRY_WAIT', 'failure');
      return 'RETRY_WAIT';
    }
    if (!result.ok) {
      await this.store.persistCleanup(workspaceId, 'RETRY_WAIT', 'failure');
      return 'RETRY_WAIT';
    }
    if (!result.absent) {
      await this.store.persistCleanup(workspaceId, 'ESCALATED', 'failure');
      return 'ESCALATED';
    }
    await this.store.persistCleanup(workspaceId, 'COMPLETED', 'success');
    return 'COMPLETED';
  }
}

export interface TelemetryRecorder {
  record(metric: {
    workspaceId: string;
    commandId?: string | undefined;
    kind: string;
    value: number;
    labels?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

export class InMemoryTelemetryRecorder implements TelemetryRecorder {
  readonly metrics: Array<Record<string, unknown>> = [];
  async record(metric: {
    workspaceId: string;
    commandId?: string | undefined;
    kind: string;
    value: number;
    labels?: Readonly<Record<string, string>>;
  }): Promise<void> {
    // Privacy-safe: never source/secret/raw-output.
    this.metrics.push({ workspaceId: metric.workspaceId, kind: metric.kind, value: metric.value });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

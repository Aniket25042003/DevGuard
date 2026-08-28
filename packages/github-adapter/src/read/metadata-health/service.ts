/**
 * C014 §10/§12 — repository metadata/health service.
 *
 * Coordination rules (C014 §12/§18/§19):
 * - Return immediately when the cached snapshot is fresh enough.
 * - Otherwise single-flight a refresh per repository; bounded fan-out.
 * - Conditional requests advance freshness on 304 without new values.
 * - Partial failures persist typed field errors and keep prior values.
 * - Rate limits return the cached view with `retryAfterMs` and defer.
 * - CAS on generation/version rejects old refreshes replacing new ones.
 * - Health events emit only on semantic (status/reason) changes.
 * - C014 grants NO write capability and never decides action authorization:
 *   readiness is evidence for preflight, not permission.
 */
import { idSchemas } from '@devguard/contracts';
import type { ConnectedRepositoryRecord, RepositoryLifecycleStatus } from '../lifecycle.js';
import {
  getSnapshotInputSchema,
  refreshMetadataInputSchema,
  repositoryRefreshHintSchema,
  type FieldFailure,
  type HealthStatus,
  type MetadataField,
  type MetadataHealthView,
  type ReadinessStatus,
  type RefreshRepositoryMetadata,
  type RefreshRepositoryMetadataInput,
  type RepositoryHealthSnapshot,
  type RepositoryMetadataSnapshot,
  type RepositoryRefreshHint,
  type HintResource,
} from './contracts.js';
import { MetadataCollector, type CollectedFields } from './collectors.js';
import { HealthEvaluator } from './health-evaluator.js';
import type { RepositoryMetadataProviderPort } from './provider-port.js';
import type { MetadataSnapshotStorePort } from '../ports/metadata-snapshot-store.js';
import {
  NoopLogPort,
  type ComponentLogPort,
  type EmittedReadEvent,
  type EventSinkPort,
  type ReadComponentEventType,
} from '../ports/shared.js';
import '../ports/error-codes.js';

/**
 * Deterministic, schema-valid operation key for a `getSnapshot`-triggered
 * refresh. A timestamp-derived ULID (zero entropy low bits) satisfies the
 * branded `operationKey` schema (C004) while keeping concurrent same-instant
 * refreshes coalescible. It is an idempotency scoping key, not a secret.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeOperationKey(tsMs: number): string {
  const buffer = new Uint8Array(16);
  new DataView(buffer.buffer).setBigUint64(0, BigInt(tsMs), false);
  let bits = 0n;
  for (const byte of buffer) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    const shift = BigInt(130 - 5 - i * 5);
    out += CROCKFORD[Number((bits >> shift) & 0x1fn)] ?? '';
  }
  return out;
}

/** Read-only lifecycle view used by C014 (satisfied by C013 records). */
export interface LifecycleReadPort {
  getRecord(repositoryDevguardId: string): Promise<ConnectedRepositoryRecord | undefined>;
}

export interface MetadataHealthServiceOptions {
  readonly store: MetadataSnapshotStorePort;
  readonly provider: RepositoryMetadataProviderPort;
  readonly lifecycle: LifecycleReadPort;
  readonly evaluator?: HealthEvaluator | undefined;
  readonly logger?: ComponentLogPort | undefined;
  readonly events?: EventSinkPort | undefined;
  readonly maxConcurrency?: number | undefined;
  /** Default snapshot freshness window (validUntil). */
  readonly fieldFreshnessMs?: number | undefined;
  /** Idempotent refresh claim TTL. */
  readonly claimTtlMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
}

const DEFAULT_FIELD_FRESHNESS_MS = 5 * 60 * 1000;
const DEFAULT_CLAIM_TTL_MS = 60 * 1000;
const DEFAULT_MAX_CONCURRENCY = 3;

interface PendingHints {
  readonly resources: Set<HintResource>;
  readonly firstHintAtMs: number;
}

export class RepositoryMetadataHealthService {
  readonly #store: MetadataSnapshotStorePort;
  readonly #provider: RepositoryMetadataProviderPort;
  readonly #lifecycle: LifecycleReadPort;
  readonly #evaluator: HealthEvaluator;
  readonly #logger: ComponentLogPort;
  readonly #events: EventSinkPort | undefined;
  readonly #maxConcurrency: number;
  readonly #fieldFreshnessMs: number;
  readonly #claimTtlMs: number;
  readonly #nowMs: () => number;
  readonly #inflight = new Map<string, Promise<MetadataHealthView>>();
  readonly #pendingHints = new Map<string, PendingHints>();

  constructor(options: MetadataHealthServiceOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#lifecycle = options.lifecycle;
    this.#evaluator = options.evaluator ?? new HealthEvaluator();
    this.#logger = options.logger ?? new NoopLogPort();
    this.#events = options.events;
    this.#maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.#fieldFreshnessMs = options.fieldFreshnessMs ?? DEFAULT_FIELD_FRESHNESS_MS;
    this.#claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  /** C014 §10 `getSnapshot`: cached view when fresh, else single-flight refresh. */
  async getSnapshot(input: {
    repositoryId: string;
    maxAgeMs: number;
  }): Promise<MetadataHealthView> {
    const parsed = getSnapshotInputSchema.parse(input);
    const repositoryId = parsed.repositoryId;
    const nowMs = this.#nowMs();

    const [cached, health, lifecycle] = await Promise.all([
      this.#store.findCurrentMetadata(repositoryId),
      this.#store.findCurrentHealth(repositoryId),
      this.#lifecycle.getRecord(repositoryId),
    ]);
    const lifecycleStatus = lifecycle?.status ?? 'unknown';
    const pending = this.#pendingHints.get(repositoryId);

    const ageMs = cached !== undefined ? nowMs - Date.parse(cached.capturedAtIso) : undefined;
    const freshEnough =
      cached !== undefined &&
      ageMs !== undefined &&
      ageMs <= parsed.maxAgeMs &&
      nowMs <= Date.parse(cached.validUntilIso) &&
      pending === undefined;

    if (freshEnough) {
      return this.#view(repositoryId, cached, health, lifecycleStatus, nowMs, false);
    }

    // Coalesced hint path: a single refresh satisfies all pending resources.
    const cause = pending !== undefined ? 'webhook' : 'preflight';
    if (pending !== undefined) this.#pendingHints.delete(repositoryId);
    return this.refresh({
      repositoryId,
      cause,
      operationKey: makeOperationKey(nowMs),
    });
  }

  /** C014 §10 `refresh`: forced refresh with idempotency by operation key. */
  async refresh(input: RefreshRepositoryMetadata): Promise<MetadataHealthView> {
    const parsed = refreshMetadataInputSchema.parse(input) as RefreshRepositoryMetadataInput;
    const repositoryId = parsed.repositoryId;
    const operationKey = parsed.operationKey;
    const nowMs = this.#nowMs();
    const inflightKey = `${repositoryId}:${operationKey}`;

    // Coalesce local in-flight work BEFORE consulting the idempotency claim:
    // a concurrent same-key call must await the first refresh's result rather
    // than being denied the claim and returning the stale persisted view.
    const coalesced = this.#inflight.get(inflightKey);
    if (coalesced !== undefined) return coalesced;

    const claim = await this.#store.claimRefresh({
      repositoryDevguardId: repositoryId,
      operationKey,
      ttlMs: this.#claimTtlMs,
      nowMs,
    });
    if (!claim.granted) {
      // Another claimer is refreshing this key (locally or a peer instance).
      // Share local in-flight work when present; otherwise return the
      // persisted result of the completed/first claim. A denied claim for
      // live work should never return a stale view over an available fresh one.
      const shared = this.#inflight.get(inflightKey);
      if (shared !== undefined) return shared;
      const [cached, health, lifecycle] = await Promise.all([
        this.#store.findCurrentMetadata(repositoryId),
        this.#store.findCurrentHealth(repositoryId),
        this.#lifecycle.getRecord(repositoryId),
      ]);
      const status = lifecycle?.status ?? 'unknown';
      return this.#view(repositoryId, cached, health, status, nowMs, false);
    }

    const promise = this.#doRefresh(repositoryId, parsed, nowMs);
    this.#inflight.set(inflightKey, promise);
    try {
      return await promise;
    } catch (cause) {
      // A failed refresh persisted nothing; release the claim so a legitimate
      // retry is not blocked for the full TTL by a claim with no result.
      await this.#store.releaseRefreshClaim({
        repositoryDevguardId: repositoryId,
        operationKey,
      });
      throw cause;
    } finally {
      this.#inflight.delete(inflightKey);
    }
  }

  async #doRefresh(
    repositoryId: string,
    parsed: RefreshRepositoryMetadataInput,
    nowMs: number,
  ): Promise<MetadataHealthView> {
    const nowIso = new Date(nowMs).toISOString();
    const [cached, lifecycle] = await Promise.all([
      this.#store.findCurrentMetadata(repositoryId),
      this.#lifecycle.getRecord(repositoryId),
    ]);
    const lifecycleStatus = lifecycle?.status ?? 'unknown';

    if (lifecycle === undefined) {
      // No lifecycle record: fail closed with honest `unknown`/blocked.
      const health = await this.#store.findCurrentHealth(repositoryId);
      return this.#view(repositoryId, cached, health, 'unknown', nowMs, true);
    }

    const fields = this.#fieldsToCollect(parsed.minimumFields);
    const collector = new MetadataCollector(this.#provider);
    const collected = await collector.collect({
      ownerLogin: lifecycle.ownerLogin,
      repoName: lifecycle.repoName,
      defaultBranch: lifecycle.defaultBranch,
      fields,
      previous: cached,
      ctx: { correlationId: `c014:${repositoryId}`, operationKey: parsed.operationKey },
      maxConcurrency: this.#maxConcurrency,
    });

    if (collected.rateLimited) {
      // C014 §18: rate limit → cached view + retry time; never fabricate.
      this.#logger.warn('repository.metadata.rate_limited', {
        repositoryId,
        status: 'deferred',
      });
      const health = await this.#store.findCurrentHealth(repositoryId);
      return this.#view(
        repositoryId,
        cached,
        health,
        lifecycleStatus,
        nowMs,
        true,
        collected.retryAfterMs,
      );
    }

    const nextGeneration = (cached?.generation ?? 0) + 1;
    const snapshot = this.#assembleSnapshot(
      repositoryId,
      lifecycle,
      collected,
      nowIso,
      nowMs,
      nextGeneration,
      cached,
    );
    const saved = await this.#store.compareAndSaveMetadata(cached?.generation, snapshot);
    if (!saved.ok) {
      // CAS rejection: an older refresh lost the race; the latest stands and
      // its evidence owns the snapshot AND the health that hangs off it. A
      // losing refresh must never advance health from its own (stale) field
      // collection, so we short-circuit to the current persisted state.
      this.#logger.warn('repository.metadata.refresh_conflict', {
        repositoryId,
        status: 'conflict',
      });
      const currentHealth = await this.#store.findCurrentHealth(repositoryId);
      return this.#view(
        repositoryId,
        saved.current ?? cached,
        currentHealth,
        lifecycleStatus,
        nowMs,
        false,
      );
    }
    const persisted = saved.saved;

    const previousHealth = await this.#store.findCurrentHealth(repositoryId);
    const healthNow = this.#evaluator.evaluate({
      repositoryDevguardId: repositoryId,
      lifecycleStatus,
      requiredPermissionsMet: this.#requiredPermissionsMet(collected),
      collected,
      nowIso,
      nowMs,
      validUntilMs: Date.parse(persisted.validUntilIso),
      capturedAtMs: Date.parse(persisted.capturedAtIso),
      computedVersion: previousHealth === undefined ? 1 : previousHealth.computedVersion + 1,
    });
    const healthSaved = await this.#store.compareAndSaveHealth(
      previousHealth?.computedVersion,
      healthNow,
    );
    const persistedHealth = healthSaved.ok ? healthSaved.saved : (healthSaved.current ?? healthNow);

    this.#logger.info('repository.metadata.refreshed', {
      repositoryId,
      status: healthNow.status,
      attempt: 1,
    });
    await this.#emit('repository.metadata.refreshed', repositoryId, {
      status: healthNow.status,
      readiness: healthNow.readiness,
      generation: persisted.generation,
      fieldFailureCount: collected.fieldFailures.length,
    });
    // Semantic health-change detection compares the previous health (captured
    // before THIS refresh's save) against the newly persisted health, so a
    // real status/reason transition emits `repository.health.changed`.
    await this.#emitHealthChangeIfNeeded(repositoryId, previousHealth, persistedHealth);
    return this.#view(repositoryId, persisted, persistedHealth, lifecycleStatus, nowMs, false);
  }

  /** C014 §10 `applyHint`: coalesce webhook/resource hints into a pending refresh. */
  async applyHint(input: RepositoryRefreshHint): Promise<void> {
    const parsed = repositoryRefreshHintSchema.parse(input);
    const nowMs = this.#nowMs();
    const existing = this.#pendingHints.get(parsed.repositoryId);
    const resources = existing?.resources ?? new Set<HintResource>();
    for (const resource of parsed.resources) resources.add(resource);
    this.#pendingHints.set(parsed.repositoryId, {
      resources,
      firstHintAtMs: existing?.firstHintAtMs ?? nowMs,
    });
    this.#logger.debug('repository.metadata.hint', { repositoryId: parsed.repositoryId });
  }

  // ---- internal helpers ------------------------------------------------------

  #fieldsToCollect(minimumFields: MetadataField[] | undefined): readonly MetadataField[] {
    if (minimumFields === undefined || minimumFields.length === 0) {
      return this.#provider.supportedFields;
    }
    // The boundary schema rejects unknown fields; collect exactly the set
    // the caller requested, nothing more.
    return minimumFields;
  }

  #assembleSnapshot(
    repositoryId: string,
    lifecycle: ConnectedRepositoryRecord,
    collected: CollectedFields,
    nowIso: string,
    nowMs: number,
    generation: number,
    previous: RepositoryMetadataSnapshot | undefined,
  ): RepositoryMetadataSnapshot {
    const identity = collected.identity;
    void idSchemas.repositoryId;
    // Critical freshness (C014 §23): the snapshot's validUntil window is only
    // extended when the critical identity/default-branch fields were actually
    // re-observed this cycle (value or 304). A partial refresh that merely
    // carries forward critical fields must not re-certify stale critical
    // metadata as fresh — so we preserve the previous snapshot's validUntil
    // instead of stamping a brand-new window for copied values.
    const criticalFreshlyObserved =
      collected.freshlyObserved.includes('identity') ||
      collected.freshlyObserved.includes('default_branch');
    const validUntilIso = criticalFreshlyObserved
      ? new Date(nowMs + this.#fieldFreshnessMs).toISOString()
      : (previous?.validUntilIso ?? new Date(nowMs + this.#fieldFreshnessMs).toISOString());
    return {
      repositoryDevguardId: repositoryId,
      githubRepositoryId: identity?.githubRepositoryId ?? lifecycle.githubRepositoryId,
      ownerLogin: identity?.ownerLogin ?? lifecycle.ownerLogin,
      repoName: identity?.repoName ?? lifecycle.repoName,
      fullName: identity?.fullName ?? lifecycle.fullName,
      defaultBranch: identity?.defaultBranch ?? lifecycle.defaultBranch,
      visibility: identity?.visibility ?? lifecycle.visibility,
      archived: identity?.archived ?? false,
      disabled: identity?.disabled ?? false,
      fork: identity?.fork ?? false,
      languages: collected.languages ?? [],
      effectivePermissions: collected.permissions ?? { kind: 'read', canPush: false },
      ...(collected.activity?.pushedAtIso !== undefined
        ? { pushedAtIso: collected.activity.pushedAtIso }
        : {}),
      ...(collected.activity?.providerUpdatedAtIso !== undefined
        ? { providerUpdatedAtIso: collected.activity.providerUpdatedAtIso }
        : {}),
      ...(collected.activity?.latestObservedSha !== undefined
        ? { latestObservedSha: collected.activity.latestObservedSha }
        : {}),
      ciDescriptors: collected.ciDescriptors ?? [],
      resourceEtags: collected.resourceEtags,
      capturedAtIso: nowIso,
      validUntilIso,
      sourceRequestIds: collected.sourceRequestIds,
      fieldFailures: collected.fieldFailures,
      schemaVersion: 1,
      generation,
    };
  }

  #requiredPermissionsMet(collected: CollectedFields): boolean {
    const permissions = collected.permissions;
    if (permissions === undefined) return false;
    // Effective provider permissions: read/write/admin peers satisfy the
    // GitHub read prerequisites for preflight purposes.
    return (
      permissions.kind === 'read' || permissions.kind === 'write' || permissions.kind === 'admin'
    );
  }

  /**
   * Semantic dedupe: health.changed is emitted only when the newly persisted
   * health differs from the health that existed BEFORE this refresh's save.
   * Comparing a record to itself would always suppress the event, so the
   * previous snapshot must be captured before saving (C014 §10).
   */
  async #emitHealthChangeIfNeeded(
    repositoryId: string,
    previous: RepositoryHealthSnapshot | undefined,
    current: RepositoryHealthSnapshot,
  ): Promise<void> {
    if (previous === undefined) return;
    const changed =
      current.status !== previous.status || current.reasonCode !== previous.reasonCode;
    if (changed) {
      await this.#emit('repository.health.changed', repositoryId, {
        from: previous.status,
        to: current.status,
        readiness: current.readiness,
        reasonCode: current.reasonCode,
      });
    }
    if (current.status === 'degraded' && current.reasonCode === 'METADATA_STALE') {
      await this.#emit('repository.metadata.stale', repositoryId, {
        lifecycleStatus: current.lifecycleStatus,
      });
    }
  }

  async #emit(
    type: ReadComponentEventType,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#events === undefined) return;
    const event: EmittedReadEvent = { type, aggregateId, payload };
    try {
      await this.#events.emit(event);
    } catch (error) {
      // Event emission is best-effort; a read service never fails on it.
      this.#logger.warn('read_component.event_emit_failed', { repositoryId: aggregateId });
      void error;
    }
  }

  #view(
    repositoryId: string,
    snapshot: RepositoryMetadataSnapshot | undefined,
    health: MetadataHealthView['health'],
    lifecycleStatus: RepositoryLifecycleStatus | 'unknown',
    nowMs: number,
    refreshPending: boolean,
    retryAfterMs?: number | undefined,
  ): MetadataHealthView {
    const ageMs = snapshot !== undefined ? nowMs - Date.parse(snapshot.capturedAtIso) : undefined;
    const status: HealthStatus = health?.status ?? 'unknown';
    const readiness: ReadinessStatus = health?.readiness ?? 'blocked';
    const partialFieldErrors: readonly FieldFailure[] = snapshot?.fieldFailures ?? [];
    return {
      repositoryDevguardId: repositoryId,
      ...(snapshot !== undefined ? { snapshot } : {}),
      ...(health !== undefined ? { health } : {}),
      ...(ageMs !== undefined ? { snapshotAgeMs: ageMs } : {}),
      partialFieldErrors,
      status,
      readiness,
      lifecycleStatus,
      refreshPending,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
}

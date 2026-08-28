/**
 * C015 §10/§12/§20/§19 — the repository-map service.
 *
 * Orchestrates exact-ref-resolved, budget-bounded evidence collection into an
 * immutable, current-pointer-guarded `RepositoryMap`. Build is idempotent by
 * operation key and cacheable by (repository, headSha, taskFingerprint,
 * schemaVersion). Budget exhaustion yields `partial` (never false completion);
 * a changed head is rejected by the store's CAS and surfaced as a safe error.
 * No command executes and no instruction gains authority here (C015 §5/§25).
 */
import { randomUUID } from 'node:crypto';
import type { EmittedReadEvent, EventSinkPort } from '../ports/shared.js';
import {
  buildRepositoryMapSchema,
  invalidateRepositoryMapSchema,
  queryRepositoryMapSchema,
  type BuildRepositoryMap,
  type InvalidateRepositoryMap,
  type MapQueryResult,
  type RepositoryMap,
  type RepositoryMapRef,
} from './contracts.js';
import { collectRepositoryMapEvidence } from './collectors.js';
import { BudgetTracker } from './budget.js';
import { taskFingerprint } from './task-fingerprint.js';
import type { RepositoryMapStorePort } from '../ports/repository-map-store.js';
import type { MapArtifactStorePort } from '../ports/map-artifact-store.js';
import type { RepositoryContentProviderPort } from './provider-port.js';
import { TargetRanker } from './target-ranker.js';

export const REPOSITORY_MAP_FRESHNESS_MS = 60 * 60 * 1000;

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export interface RepositoryMapServiceDeps {
  readonly provider: RepositoryContentProviderPort;
  readonly store: RepositoryMapStorePort;
  readonly artifactStore: MapArtifactStorePort;
  readonly clock?: { readonly nowMs: () => number; readonly nowIso: () => string };
  readonly emit?: EventSinkPort;
}

export interface RepositoryMapService {
  build(input: BuildRepositoryMap): Promise<Result<RepositoryMapRef>>;
  get(mapId: string): Promise<Result<RepositoryMap>>;
  query(input: {
    readonly mapId: string;
    readonly kinds?: readonly string[] | undefined;
    readonly paths?: readonly string[] | undefined;
    readonly limit: number;
  }): Promise<Result<MapQueryResult>>;
  invalidate(input: InvalidateRepositoryMap): Promise<Result<void>>;
}

export class RepositoryMapServiceGate implements RepositoryMapService {
  readonly #provider: RepositoryContentProviderPort;
  readonly #store: RepositoryMapStorePort;
  readonly #artifactStore: MapArtifactStorePort;
  readonly #clock: { readonly nowMs: () => number; readonly nowIso: () => string };
  readonly #emit: EventSinkPort;

  constructor(deps: RepositoryMapServiceDeps) {
    this.#provider = deps.provider;
    this.#store = deps.store;
    this.#artifactStore = deps.artifactStore;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() };
    this.#emit = deps.emit ?? new NoopEventSink();
  }

  async build(input: BuildRepositoryMap): Promise<Result<RepositoryMapRef>> {
    const parsed = buildRepositoryMapSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', detail: 'build input invalid' };
    }
    const operation = parsed.data;

    // Idempotency (C015 §20): same operation key returns the existing map ref.
    const existingByOp = await this.#store.findByOperationKey(operation.operationKey);
    if (existingByOp !== undefined && existingByOp.status !== 'superseded') {
      return {
        ok: true,
        value: {
          mapId: existingByOp.id,
          repositoryDevguardId: existingByOp.repositoryDevguardId,
          headSha: existingByOp.headSha,
          status: existingByOp.status,
        },
      };
    }

    // Exact-ref binding: a map never targets a moving ref (C015 §25).
    const resolved = await this.#provider.resolveExactRef({ ref: operation.ref });
    if (!resolved.ok) {
      await this.#emitEvent('repository.map.started', operation.workflowRunId, {
        repositoryId: operation.repositoryId,
        reason: `resolve ref: ${resolved.code}`,
      });
      return { ok: false, code: resolved.code, detail: resolved.detail };
    }
    const headSha = resolved.value.commitSha;

    const fingerprint = taskFingerprint({
      repositoryId: operation.repositoryId,
      ref: operation.ref,
      taskKind: operation.task.kind,
      terms: operation.task.terms,
      ...(operation.task.issueNumber !== undefined
        ? { issueNumber: operation.task.issueNumber }
        : {}),
      ...(operation.task.prNumber !== undefined ? { prNumber: operation.task.prNumber } : {}),
    });

    // Cache key: (repository, headSha, taskFingerprint, schemaVersion).
    const current = await this.#store.findCurrent(operation.repositoryId);
    if (
      current !== undefined &&
      current.status === 'complete' &&
      current.headSha === headSha &&
      current.taskFingerprint === fingerprint &&
      current.schemaVersion === 1
    ) {
      return {
        ok: true,
        value: {
          mapId: current.id,
          repositoryDevguardId: current.repositoryDevguardId,
          headSha: current.headSha,
          status: current.status,
        },
      };
    }

    await this.#emitEvent('repository.map.started', operation.workflowRunId, {
      repositoryId: operation.repositoryId,
      headSha,
    });

    const budget = new BudgetTracker(operation.budget, this.#clock.nowMs());
    const evidence = await collectRepositoryMapEvidence({
      repositoryDevguardId: operation.repositoryId,
      headSha,
      provider: this.#provider,
      budget,
      artifactStore: this.#artifactStore,
      task: {
        kind: operation.task.kind,
        terms: operation.task.terms,
        ...(operation.task.issueNumber !== undefined
          ? { issueNumber: operation.task.issueNumber }
          : {}),
        ...(operation.task.prNumber !== undefined ? { prNumber: operation.task.prNumber } : {}),
      },
      nowMs: this.#clock.nowMs(),
      nowIso: this.#clock.nowIso(),
      correlationId: operation.workflowRunId,
    });

    const status = this.#finalStatus(evidence);
    void status;

    const nowIso = this.#clock.nowIso();
    const map: RepositoryMap = {
      id: randomUUID(),
      repositoryDevguardId: operation.repositoryId,
      baseRef: operation.ref,
      headSha,
      taskFingerprint: fingerprint,
      schemaVersion: 1,
      status: this.#finalStatus(evidence),
      generatedAtIso: nowIso,
      expiresAtIso: new Date(Date.parse(nowIso) + REPOSITORY_MAP_FRESHNESS_MS).toISOString(),
      budgets: operation.budget,
      truncation: evidence.truncation,
      languages: evidence.languages,
      treeSummary: evidence.treeSummary,
      manifests: evidence.manifests,
      commands: evidence.commands,
      ciWorkflows: evidence.ciWorkflows,
      instructionCandidates: evidence.instructionCandidates,
      recentCommits: evidence.recentCommits,
      linkedContext: evidence.linkedContext,
      targetedPaths: evidence.targetedPaths,
      evidenceRefs: [...new Set(evidence.instructionCandidates.map((c) => c.artifactRef))],
      facts: evidence.facts,
      warnings: evidence.warnings,
      operationKey: operation.operationKey,
    };

    const saved = await this.#store.save(map);
    if (!saved.ok) {
      await this.#emitEvent('repository.map.superseded', operation.workflowRunId, {
        repositoryId: operation.repositoryId,
        headSha,
        reason: saved.code,
      });
      return {
        ok: false,
        code: saved.code,
        detail: 'a newer map for this repository/head already exists',
      };
    }

    await this.#emitEvent(
      evidence.partial ? 'repository.map.partial' : 'repository.map.created',
      operation.workflowRunId,
      {
        repositoryId: operation.repositoryId,
        mapId: map.id,
        headSha,
        partial: evidence.partial,
      },
    );

    return {
      ok: true,
      value: {
        mapId: map.id,
        repositoryDevguardId: map.repositoryDevguardId,
        headSha,
        status: map.status,
      },
    };
  }

  async get(mapId: string): Promise<Result<RepositoryMap>> {
    const normalized = mapId.trim();
    if (normalized.length === 0 || normalized.length > 128) {
      return { ok: false, code: 'VALIDATION_FAILED', detail: 'mapId invalid' };
    }
    const map = await this.#store.get(normalized);
    return map === undefined
      ? { ok: false, code: 'NOT_FOUND', detail: 'repository map not found' }
      : { ok: true, value: map };
  }

  async query(input: {
    readonly mapId: string;
    readonly kinds?: readonly string[] | undefined;
    readonly paths?: readonly string[] | undefined;
    readonly limit: number;
  }): Promise<Result<MapQueryResult>> {
    const parsed = queryRepositoryMapSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', detail: 'query input invalid' };
    }
    const q = parsed.data;
    const map = await this.#store.get(q.mapId);
    if (map === undefined) {
      return { ok: false, code: 'NOT_FOUND', detail: 'repository map not found' };
    }

    const ranker = new TargetRanker();
    let paths: Set<string> | undefined;
    if (q.paths !== undefined && q.paths.length > 0) {
      const canonical: string[] = [];
      for (const raw of q.paths) {
        try {
          canonical.push(ranker.canonicalize(raw));
        } catch {
          return { ok: false, code: 'VALIDATION_FAILED', detail: 'invalid query path' };
        }
      }
      paths = new Set(canonical);
    }

    const kinds = q.kinds !== undefined ? new Set(q.kinds) : undefined;
    const filtered = map.facts.filter(
      (fact) =>
        (kinds === undefined || kinds.has(fact.kind)) &&
        (paths === undefined ||
          (fact.provenance.path !== undefined && paths.has(fact.provenance.path))),
    );
    const returned = filtered.slice(0, q.limit);

    return {
      ok: true,
      value: {
        mapId: map.id,
        headSha: map.headSha,
        status: map.status,
        facts: returned,
        evidenceRefs: map.evidenceRefs,
        truncation: {
          returnedCount: returned.length,
          totalCount: filtered.length,
        },
      },
    };
  }

  async invalidate(input: InvalidateRepositoryMap): Promise<Result<void>> {
    const parsed = invalidateRepositoryMapSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: 'VALIDATION_FAILED', detail: 'invalidate input invalid' };
    }
    const count = await this.#store.supersede(parsed.data.repositoryId, '');
    await this.#emitEvent('repository.map.superseded', parsed.data.repositoryId, {
      repositoryId: parsed.data.repositoryId,
      count,
      reason: parsed.data.reason,
    });
    return { ok: true, value: undefined };
  }

  #finalStatus(evidence: { readonly partial: boolean }): 'complete' | 'partial' {
    return evidence.partial ? 'partial' : 'complete';
  }

  async #emitEvent(
    type: EmittedReadEvent['type'],
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#emit.emit({ type, aggregateId, payload });
  }
}

/** Default no-op event sink until the composition root wires the bus. */
class NoopEventSink implements EventSinkPort {
  async emit(_event: EmittedReadEvent): Promise<void> {}
}

/**
 * C015 §13/§19 — repository map store port (current-pointer + CAS boundary).
 *
 * Invariants (C015 §19/§25): a superseded map can never become current; an
 * old map for a changed head can never replace the fresh current; building
 * is lease-serialized per cache key (fake approximates with CAS-by-ref).
 * Persistence is deferred to C011/C012; the in-memory fake enforces the same
 * invariant rules deterministically.
 */
import type { RepositoryMap } from '../repository-map/contracts.js';

export interface MapSaveResult {
  readonly ok: boolean;
  readonly code: 'SAVED' | 'STALE_CURRENT' | 'SUPERSEDED_TARGET';
  readonly current?: RepositoryMap | undefined;
}

export interface RepositoryMapStorePort {
  save(map: RepositoryMap): Promise<MapSaveResult>;
  get(mapId: string): Promise<RepositoryMap | undefined>;
  findCurrent(repositoryDevguardId: string): Promise<RepositoryMap | undefined>;
  findByOperationKey(operationKey: string): Promise<RepositoryMap | undefined>;
  /** Marks the surviving maps for a repository superseded by `superseding`. */
  supersede(repositoryDevguardId: string, supersedingHeadSha: string): Promise<number>;
}

/** Deterministic in-memory fake enforcing current-pointer invariants. */
export class InMemoryRepositoryMapStore implements RepositoryMapStorePort {
  readonly maps = new Map<string, RepositoryMap>();
  readonly current = new Map<string, RepositoryMap>();

  async save(map: RepositoryMap): Promise<MapSaveResult> {
    const existing = this.maps.get(map.id);
    if (existing !== undefined && existing.status === 'superseded') {
      return { ok: false, code: 'SUPERSEDED_TARGET', current: existing };
    }
    const current = this.current.get(map.repositoryDevguardId);
    if (map.status === 'superseded' || map.status === 'failed') {
      // Terminal-failure/superseded maps never become the current pointer.
      return { ok: true, code: 'SAVED', current };
    }
    if (
      current !== undefined &&
      current.headSha !== map.headSha &&
      current.status !== 'superseded'
    ) {
      // Same repository, different head: the newer map is only publishable
      // when the current one is already superseded (C015 §19 §25).
      return { ok: false, code: 'STALE_CURRENT', current };
    }
    // Same head or no current: republish with the fresher generation.
    if (current === undefined || current.headSha === map.headSha) {
      this.maps.set(map.id, map);
      this.current.set(map.repositoryDevguardId, map);
      return { ok: true, code: 'SAVED', current: map };
    }
    return { ok: false, code: 'STALE_CURRENT', current };
  }

  async get(mapId: string): Promise<RepositoryMap | undefined> {
    return this.maps.get(mapId);
  }

  async findCurrent(repositoryDevguardId: string): Promise<RepositoryMap | undefined> {
    return this.current.get(repositoryDevguardId);
  }

  async findByOperationKey(operationKey: string): Promise<RepositoryMap | undefined> {
    for (const map of this.maps.values()) {
      if (map.operationKey === operationKey) return map;
    }
    return undefined;
  }

  async supersede(repositoryDevguardId: string, supersedingHeadSha: string): Promise<number> {
    let count = 0;
    for (const map of this.maps.values()) {
      if (map.repositoryDevguardId !== repositoryDevguardId) continue;
      if (map.headSha === supersedingHeadSha) continue;
      if (map.status === 'superseded' || map.status === 'failed') continue;
      const superseded: RepositoryMap = { ...map, status: 'superseded' };
      this.maps.set(map.id, superseded);
      if (this.current.get(repositoryDevguardId)?.id === map.id) {
        this.current.delete(repositoryDevguardId);
      }
      count += 1;
    }
    return count;
  }
}

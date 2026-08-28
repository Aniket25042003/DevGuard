/**
 * C016 §13/§19 — instruction-snapshot store port (current-pointer + CAS).
 *
 * Snapshots are immutable and bound to exact policy/workflow/ref versions; a
 * repository/policy/workflow change supersedes the current pointer. The
 * in-memory fake enforces the same invariant rules deterministically.
 */
import type { InstructionSnapshot } from './contracts.js';

export interface SnapshotSaveResult {
  readonly ok: boolean;
  readonly code: 'SAVED' | 'STALE_CURRENT' | 'SUPERSEDED_TARGET';
  readonly current?: InstructionSnapshot | undefined;
}

export interface InstructionSnapshotStorePort {
  save(snapshot: InstructionSnapshot): Promise<SnapshotSaveResult>;
  get(id: string): Promise<InstructionSnapshot | undefined>;
  findByOperationKey(operationKey: string): Promise<InstructionSnapshot | undefined>;
  /** Supersede all surviving snapshots for a repository. */
  supersede(repositoryId: string): Promise<number>;
}

export class InMemoryInstructionSnapshotStore implements InstructionSnapshotStorePort {
  readonly snapshots = new Map<string, InstructionSnapshot>();
  readonly current = new Map<string, InstructionSnapshot>();

  async save(snapshot: InstructionSnapshot): Promise<SnapshotSaveResult> {
    const existing = this.snapshots.get(snapshot.id);
    if (existing !== undefined && existing.status === 'superseded') {
      return { ok: false, code: 'SUPERSEDED_TARGET', current: existing };
    }
    if (snapshot.status !== 'superseded' && snapshot.status !== 'rejected') {
      const current = this.current.get(snapshot.repositoryId);
      if (
        current !== undefined &&
        current.status !== 'superseded' &&
        snapshotVersionChanged(current, snapshot)
      ) {
        return { ok: false, code: 'STALE_CURRENT', current };
      }
    }
    this.snapshots.set(snapshot.id, snapshot);
    if (snapshot.status === 'superseded' || snapshot.status === 'rejected') {
      return { ok: true, code: 'SAVED', current: this.current.get(snapshot.repositoryId) };
    }
    const current = this.current.get(snapshot.repositoryId);
    if (
      current !== undefined &&
      current.status !== 'superseded' &&
      snapshotVersionChanged(current, snapshot)
    ) {
      return { ok: false, code: 'STALE_CURRENT', current };
    }
    this.current.set(snapshot.repositoryId, snapshot);
    return { ok: true, code: 'SAVED', current: snapshot };
  }

  async get(id: string): Promise<InstructionSnapshot | undefined> {
    return this.snapshots.get(id);
  }

  async findByOperationKey(operationKey: string): Promise<InstructionSnapshot | undefined> {
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.operationKey === operationKey) return snapshot;
    }
    return undefined;
  }

  async supersede(repositoryId: string): Promise<number> {
    let count = 0;
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.repositoryId !== repositoryId) continue;
      if (snapshot.status === 'superseded' || snapshot.status === 'rejected') continue;
      this.snapshots.set(snapshot.id, { ...snapshot, status: 'superseded' });
      if (this.current.get(repositoryId)?.id === snapshot.id) {
        this.current.delete(repositoryId);
      }
      count += 1;
    }
    return count;
  }
}

/** True when the (policy/workflow/ref) binding differs from the current pointer. */
function snapshotVersionChanged(
  current: InstructionSnapshot,
  candidate: InstructionSnapshot,
): boolean {
  return (
    current.policyVersionId !== candidate.policyVersionId ||
    current.workflowDefinitionVersion !== candidate.workflowDefinitionVersion ||
    current.headSha !== candidate.headSha
  );
}

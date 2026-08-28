/**
 * C045 §13/§23.6 — snapshot persistence port (C046 integration point).
 *
 * C045 produces immutable `WorkflowDefinitionSnapshot`s; C046 persists one
 * with each run in the SAME transaction. Historical rows are never mutated.
 * This port lets the registry/app record a snapshot through the composition
 * root without owning SQL.
 */
import type { WorkflowDefinitionSnapshotShape } from '../schemas/snapshot.js';

export interface StoredSnapshot {
  readonly snapshot: WorkflowDefinitionSnapshotShape;
  /** Opaque durable reference returned by the persistence implementation. */
  readonly snapshotRef: string;
  readonly storedAt: string;
}

export interface SnapshotPersistencePort {
  /** Persist an immutable snapshot (caller guarantees one-write policy). */
  save(snapshot: WorkflowDefinitionSnapshotShape): Promise<StoredSnapshot>;
  /** Load by durable reference for restart reconciliation (C046). */
  findByRef(snapshotRef: string): Promise<WorkflowDefinitionSnapshotShape | undefined>;
}

export type { WorkflowDefinitionSnapshotShape };

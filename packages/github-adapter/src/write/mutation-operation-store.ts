/**
 * C020 §13/§19/§20 — mutation operation + branch-ownership store port.
 *
 * Operations are idempotent by `(operationKey)` with a canonical input digest:
 * the same key + same digest replays; the same key + different digest is
 * rejected. Branch ownership is exclusive to one workflow run for the lifecycle
 * of the MVP branch. The in-memory fake enforces these invariants.
 */
import type { GitMutationOperation, GitRepoRef } from './contracts.js';

export type ClaimResult =
  | { readonly ok: true; readonly operation: GitMutationOperation; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly code: 'DIGEST_CONFLICT' | 'OWNERSHIP_CONFLICT';
      readonly detail: string;
      readonly existing: GitMutationOperation | undefined;
    };

export interface MutationOperationStorePort {
  claim(operation: GitMutationOperation): Promise<ClaimResult>;
  record(operation: GitMutationOperation): Promise<void>;
  get(id: string): Promise<GitMutationOperation | undefined>;
  findByIdempotency(operationKey: string): Promise<GitMutationOperation | undefined>;
}

export class InMemoryMutationOperationStore implements MutationOperationStorePort {
  readonly ops = new Map<string, GitMutationOperation>();
  readonly ownership = new Map<string, string>(); // branchKey -> workflowRunId

  keyOf(repository: GitRepoRef, branch: string): string {
    return `${repository.owner}/${repository.repo}/heads/${branch}`;
  }

  async claim(operation: GitMutationOperation): Promise<ClaimResult> {
    const byOp = await this.findByIdempotency(operation.operationKey);
    if (byOp !== undefined) {
      if (byOp.kind === operation.kind && byOp.inputDigest === operation.inputDigest) {
        return { ok: true, operation: byOp, replayed: true };
      }
      return {
        ok: false,
        code: 'DIGEST_CONFLICT',
        detail: 'operation key reused with different inputs',
        existing: byOp,
      };
    }
    const branchKey = this.keyOf(operation.repository, operation.branch);
    const owner = this.ownership.get(branchKey);
    if (owner !== undefined && owner !== operation.workflowRunId) {
      return {
        ok: false,
        code: 'OWNERSHIP_CONFLICT',
        detail: 'branch is owned by another run',
        existing: undefined,
      };
    }
    this.ownership.set(branchKey, operation.workflowRunId);
    this.ops.set(operation.id, operation);
    return { ok: true, operation, replayed: false };
  }

  async record(operation: GitMutationOperation): Promise<void> {
    this.ops.set(operation.id, operation);
  }

  async get(id: string): Promise<GitMutationOperation | undefined> {
    return this.ops.get(id);
  }

  async findByIdempotency(operationKey: string): Promise<GitMutationOperation | undefined> {
    for (const op of this.ops.values()) {
      if (op.operationKey === operationKey) return op;
    }
    return undefined;
  }
}

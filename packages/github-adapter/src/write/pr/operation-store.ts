/**
 * C021 §13/§20 — PR mutation operation store.
 *
 * Self-contained (does not depend on C020): idempotent by `(operationKey)` with
 * a canonical input digest; same key + same digest replays, different digest is
 * rejected; attempts are append-only by state.
 */
export interface PrOperation {
  readonly id: string;
  readonly kind: string;
  readonly operationKey: string;
  readonly inputDigest: string;
  readonly state: string;
  readonly attempts: number;
  readonly workflowRunId: string;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly providerRefs: readonly string[];
}

export type PrClaimResult =
  | { readonly ok: true; readonly operation: PrOperation; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly code: 'DIGEST_CONFLICT';
      readonly detail: string;
      readonly existing: PrOperation | undefined;
    };

export interface PrOperationStorePort {
  claim(operation: PrOperation): Promise<PrClaimResult>;
  record(operation: PrOperation): Promise<void>;
  get(id: string): Promise<PrOperation | undefined>;
  findByIdempotency(operationKey: string): Promise<PrOperation | undefined>;
}

export class InMemoryPrOperationStore implements PrOperationStorePort {
  readonly ops = new Map<string, PrOperation>();

  async claim(operation: PrOperation): Promise<PrClaimResult> {
    const existing = this.findByIdempotencySync(operation.operationKey);
    if (existing !== undefined) {
      if (existing.kind === operation.kind && existing.inputDigest === operation.inputDigest) {
        return { ok: true, operation: existing, replayed: true };
      }
      return {
        ok: false,
        code: 'DIGEST_CONFLICT',
        detail: 'operation key reused with different inputs',
        existing,
      };
    }
    this.ops.set(operation.id, operation);
    return { ok: true, operation, replayed: false };
  }

  async record(operation: PrOperation): Promise<void> {
    this.ops.set(operation.id, operation);
  }

  async get(id: string): Promise<PrOperation | undefined> {
    return this.ops.get(id);
  }

  async findByIdempotency(operationKey: string): Promise<PrOperation | undefined> {
    return this.findByIdempotencySync(operationKey);
  }

  private findByIdempotencySync(operationKey: string): PrOperation | undefined {
    for (const op of this.ops.values()) {
      if (op.operationKey === operationKey) return op;
    }
    return undefined;
  }
}

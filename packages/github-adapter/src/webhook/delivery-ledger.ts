/**
 * C022 §9/§13/§19 — delivery ledger + FSM + payload vault.
 *
 * A delivery is claimed exactly once by provider delivery id; a duplicate HTTP
 * request returns the original's acceptance/state, never a second row, and never
 * overwrites original bytes. Transitions are guarded by the FSM; failed worker
 * leases return to `dispatch_pending`. Raw payload is held in a short-TTL vault
 * keyed by delivery id; only its SHA-256 and bounded metadata persist in the
 * ledger.
 */
import { createHash } from 'node:crypto';
import type { DeliveryLedgerRow, DeliveryState, WebhookEventName } from './contracts.js';

export type LedgerClaimResult =
  | { readonly ok: true; readonly row: DeliveryLedgerRow; readonly created: boolean }
  | { readonly ok: false; readonly code: 'DUPLICATE'; readonly row: DeliveryLedgerRow };

export interface DeliveryLedgerPort {
  claim(row: DeliveryLedgerRow): Promise<LedgerClaimResult>;
  get(deliveryId: string): Promise<DeliveryLedgerRow | undefined>;
  transition(
    deliveryId: string,
    to: DeliveryState,
    errorCode?: string,
  ): Promise<DeliveryLedgerRow | undefined>;
}

const EDGES: Readonly<Record<string, ReadonlyArray<[DeliveryState, DeliveryState]>>> = {
  dispatch: [
    ['accepted', 'dispatch_pending'],
    ['retry_wait', 'dispatch_pending'],
  ],
  process: [['dispatch_pending', 'processing']],
  reconcile: [['processing', 'reconciling']],
  routed: [['reconciling', 'routed']],
  ignored: [
    ['processing', 'ignored'],
    ['reconciling', 'ignored'],
  ],
  retry: [['reconciling', 'retry_wait']],
  dead_letter: [['processing', 'dead_lettered']],
  lease_expired: [
    ['processing', 'dispatch_pending'],
    ['reconciling', 'dispatch_pending'],
  ],
};

export type Trigger = keyof typeof EDGES;

export function canTransition(from: DeliveryState, trigger: Trigger): boolean {
  return (EDGES[trigger] ?? []).some(([f]) => f === from);
}

export function resolveDeliveryTransition(
  from: DeliveryState,
  trigger: Trigger,
): DeliveryState | undefined {
  return EDGES[trigger]?.find(([f]) => f === from)?.[1];
}

export class InMemoryDeliveryLedger implements DeliveryLedgerPort {
  readonly rows = new Map<string, DeliveryLedgerRow>();

  async claim(row: DeliveryLedgerRow): Promise<LedgerClaimResult> {
    const existing = this.rows.get(row.deliveryId);
    if (existing !== undefined) {
      return { ok: false, code: 'DUPLICATE', row: existing };
    }
    this.rows.set(row.deliveryId, row);
    return { ok: true, row, created: true };
  }

  async get(deliveryId: string): Promise<DeliveryLedgerRow | undefined> {
    return this.rows.get(deliveryId);
  }

  async transition(
    deliveryId: string,
    to: DeliveryState,
    errorCode?: string,
  ): Promise<DeliveryLedgerRow | undefined> {
    const row = this.rows.get(deliveryId);
    if (row === undefined) return undefined;
    const updated: DeliveryLedgerRow = {
      ...row,
      state: to,
      attempts: row.attempts + 1,
      lastErrorCode: errorCode,
    };
    this.rows.set(deliveryId, updated);
    return updated;
  }
}

/** Short-TTL raw-payload vault (in-memory; encrypted/durable vault to follow). */
export interface PayloadVaultPort {
  put(deliveryId: string, bytes: Uint8Array): void;
  get(deliveryId: string): Uint8Array | undefined;
  remove(deliveryId: string): void;
}

export class InMemoryPayloadVault implements PayloadVaultPort {
  readonly store = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
  readonly ttlMs = 5 * 60 * 1000;
  put(deliveryId: string, bytes: Uint8Array): void {
    this.store.set(deliveryId, { bytes: new Uint8Array(bytes), expiresAt: Date.now() + this.ttlMs });
  }
  get(deliveryId: string): Uint8Array | undefined {
    const entry = this.store.get(deliveryId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(deliveryId);
      return undefined;
    }
    return new Uint8Array(entry.bytes);
  }
  remove(deliveryId: string): void {
    this.store.delete(deliveryId);
  }
}

export function deliveryRow(
  deliveryId: string,
  event: WebhookEventName,
  signatureVersion: number,
  rawBytes: Uint8Array,
  receivedAtIso: string,
): DeliveryLedgerRow {
  return {
    deliveryId,
    event,
    signatureVersion,
    payloadHash: sha256Hex(rawBytes),
    payloadBytes: rawBytes.byteLength,
    state: 'accepted',
    attempts: 0,
    receivedAtIso,
  };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function bytesToString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

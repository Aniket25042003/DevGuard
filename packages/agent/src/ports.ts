/**
 * C036 — typed ports and primitives for the TrueForge contract adapter.
 *
 * `RawProviderChannel` is the seam the provider client (composition root)
 * implements. It returns RAW payloads only; everything that reaches DevGuard
 * goes through the mapper (validate -> normalize -> redact). `SnapshotStorePort`
 * is append-only persistence for contract snapshots (DB-backed in production,
 * in-memory here for unit tests). Provider SDK types never cross these ports.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderIdentification } from './snapshot.js';
import type { ContractSnapshot } from './snapshot.js';

/**
 * Raw identification REPORT as returned by the provider channel — the raw
 * wire shape, WITHOUT the endpointIdentity that DevGuard knows locally. The
 * mapper adds endpointIdentity during normalization.
 */
export type RawIdentificationReport = Omit<ProviderIdentification, 'endpointIdentity'>;

export interface AgentClock {
  nowIso(): string;
  nowMs(): number;
}

export const systemClock: AgentClock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export interface AgentIdGenerator {
  uuid(): string;
}

export const systemIds: AgentIdGenerator = {
  uuid: () => randomUUID(),
};

// --- Verification probe suite -------------------------------------------------
export const VERIFICATION_PROBE_IDS = [
  'identify',
  'session_probe',
  'turn_probe',
  'event_probe',
  'interception_probe',
  'required_action_probe',
  'sandbox_probe',
  'context_probe',
] as const;
export type VerificationProbeId = (typeof VERIFICATION_PROBE_IDS)[number];

export interface VerificationProbeSpec {
  readonly probe: VerificationProbeId;
  /** Capabilities this probe purports to verify. */
  readonly capabilityNames: readonly string[];
}

/** Fixed, read-only probe suite. Probes never mutate provider state. */
export const VERIFICATION_PROBE_SUITE: readonly VerificationProbeSpec[] = Object.freeze([
  { probe: 'session_probe', capabilityNames: ['session_create', 'session_get', 'one_active_turn'] },
  { probe: 'turn_probe', capabilityNames: ['turn_create', 'turn_get', 'final_response'] },
  {
    probe: 'event_probe',
    capabilityNames: [
      'event_stream',
      'event_cursor',
      'event_replay',
      'event_delta',
      'idempotency_semantics',
    ],
  },
  {
    probe: 'interception_probe',
    capabilityNames: ['mcp_interception', 'checkpoint_replay', 'cancellation'],
  },
  { probe: 'required_action_probe', capabilityNames: ['required_action_resume'] },
  // Read-only capability-declaration probes: assert the runtime exposes the
  // sandbox/context facilities WITHOUT executing or mutating anything. Actual
  // sandbox isolation and multi-agent context behavior are each later proven by
  // their own verified flow (C041/sandbox, C040); presence alone never
  // authorizes privileged execution.
  { probe: 'sandbox_probe', capabilityNames: ['sandbox'] },
  { probe: 'context_probe', capabilityNames: ['subagents', 'context_compaction'] },
]);

/**
 * Raw provider channel implemented by the TrueForge adapter client. Every
 * method returns opaque (possibly malformed) payloads to be validated by the
 * mapper; the channel is read-only / harmless and never used for privileged work.
 */
export interface RawProviderChannel {
  readonly endpointIdentity: string;
  readonly provider: string;
  /** Read-only runtime identification (version, integrity, auth, topology). */
  identify(): Promise<RawIdentificationReport>;
  /** Run one harmless verification probe; returns the raw provider payload. */
  runProbe(spec: VerificationProbeSpec): Promise<unknown>;
  /** Whether the endpoint is currently reachable/authorized. */
  health(): Promise<{ readonly available: boolean; readonly reason?: string | undefined }>;
  /**
   * Whether the runtime exposes direct mutative GitHub MCP tools. Presence is a
   * FATAL property until C039 routes them; never polled for privileged execution.
   */
  detectsDirectMutativeGithubTools(): Promise<boolean>;
}

/** Append-only snapshot persistence; one current snapshot per endpoint. */
export interface SnapshotStorePort {
  loadCurrent(endpointIdentity: string): Promise<ContractSnapshot | undefined>;
  /** Idempotent by snapshot id; a newer recent not superseding existing. */
  record(snapshot: ContractSnapshot): Promise<void>;
}

/** In-memory append-only store (unit tests; never a proxy for the DB port). */
export class InMemorySnapshotStore implements SnapshotStorePort {
  private readonly byEndpoint = new Map<string, ContractSnapshot>();

  async loadCurrent(endpointIdentity: string): Promise<ContractSnapshot | undefined> {
    return this.byEndpoint.get(endpointIdentity);
  }

  async record(snapshot: ContractSnapshot): Promise<void> {
    const existing = this.byEndpoint.get(snapshot.endpointIdentity);
    // Same snapshot id is idempotent; otherwise supersede (never mutate).
    if (existing && existing.id !== snapshot.id) {
      this.byEndpoint.set(snapshot.endpointIdentity, snapshot);
      return;
    }
    if (!existing) this.byEndpoint.set(snapshot.endpointIdentity, snapshot);
  }
}

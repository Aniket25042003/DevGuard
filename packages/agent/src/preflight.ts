/**
 * C036 §10/§23 — startup/preflight compatibility gate.
 *
 * Before any privileged work, readiness must be proven against a current,
 * fresh, compatible snapshot. Preflight fails closed: no snapshot, non-
 * operational status, staleness, or a present mandatory-capability miss all
 * yield not-ready. Optional-capability absences yield a degraded-but-ready state.
 * If a live re-identification is injected, digest drift also disables readiness
 * and emits `agent.contract_drift.v1` rather than silently degrading.
 */
import type { EventEnvelopeShape } from '@devguard/contracts';
import { MANDATORY_CAPABILITIES, OPTIONAL_CAPABILITIES } from './capabilities.js';
import { isOperational, type CompatibilityStatus } from './compatibility.js';
import {
  isSnapshotFresh,
  snapshotDigest,
  verifySnapshotIntegrity,
  type ContractSnapshot,
  type ProviderIdentification,
} from './snapshot.js';
import { AGENT_EVENT_TYPES, makeAgentEvent } from './events.js';
import type { SnapshotStorePort, RawProviderChannel } from './ports.js';

export interface StartupPreflightDeps {
  readonly channel: RawProviderChannel;
  readonly store: SnapshotStorePort;
  readonly clock?: { readonly nowIso: () => string; readonly nowMs: () => number };
  readonly emit?: (envelope: EventEnvelopeShape) => void;
  /**
   * Optional live re-identification for drift detection. When omitted, drift is
   * not checked and readiness relies solely on the stored snapshot.
   */
  readonly liveIdentify?: () => Promise<ProviderIdentification>;
}

export interface PreflightResult {
  readonly ready: boolean;
  readonly status: CompatibilityStatus;
  readonly reason: string;
  readonly snapshot?: ContractSnapshot | undefined;
  readonly driftDetected: boolean;
  readonly missingMandatory: readonly string[];
  readonly missingOptional: readonly string[];
}

export interface StartupPreflight {
  readonly run: () => Promise<PreflightResult>;
}

export function createStartupPreflight(deps: StartupPreflightDeps): StartupPreflight {
  const clock = deps.clock ?? { nowIso: () => new Date().toISOString(), nowMs: () => Date.now() };

  async function run(): Promise<PreflightResult> {
    const current = await deps.store.loadCurrent(deps.channel.endpointIdentity);

    if (current === undefined) {
      return {
        ready: false,
        status: 'UNVERIFIED',
        reason: 'No agent contract snapshot exists for this endpoint.',
        driftDetected: false,
        missingMandatory: MANDATORY_CAPABILITIES,
        missingOptional: OPTIONAL_CAPABILITIES,
      };
    }

    // A loaded snapshot is only readiness evidence after it re-passed schema,
    // digest, identity, and status-vs-capability verification. Corrupted or
    // tampered persistence must never grant readiness.
    const integrity = verifySnapshotIntegrity(current, deps.channel.endpointIdentity);
    if (!integrity.valid) {
      return {
        ready: false,
        status: current.status,
        reason: `Contract snapshot failed integrity verification (${integrity.failure}).`,
        snapshot: current,
        driftDetected: false,
        missingMandatory: mandatoryMissing(current),
        missingOptional: optionalMissing(current),
      };
    }

    if (!isOperational(current.status)) {
      return {
        ready: false,
        status: current.status,
        reason: `Contract snapshot is not operational (status ${current.status}).`,
        snapshot: current,
        driftDetected: false,
        missingMandatory: mandatoryMissing(current),
        missingOptional: optionalMissing(current),
      };
    }

    if (!isSnapshotFresh(current, clock.nowMs())) {
      return {
        ready: false,
        status: current.status,
        reason: 'Contract snapshot is stale and must be reverified.',
        snapshot: current,
        driftDetected: false,
        missingMandatory: mandatoryMissing(current),
        missingOptional: optionalMissing(current),
      };
    }

    const missingMandatory = mandatoryMissing(current);
    if (missingMandatory.length > 0) {
      return {
        ready: false,
        status: current.status,
        reason: `A mandatory capability is unverified: ${missingMandatory.join(', ')}.`,
        snapshot: current,
        driftDetected: false,
        missingMandatory,
        missingOptional: optionalMissing(current),
      };
    }

    let driftDetected = false;
    let observedDigest = current.digest;
    if (deps.liveIdentify) {
      try {
        const live = await deps.liveIdentify();
        observedDigest = observedDigestFor(current, live);
        driftDetected = current.digest !== observedDigest;
      } catch {
        // Unable to confirm drift -> treat as drift (fail closed) with an
        // indeterminate observed digest (rendered via a placeholder digest).
        driftDetected = true;
        observedDigest = '0'.repeat(64);
      }
    }

    if (driftDetected) {
      const envelope = makeAgentEvent({
        type: AGENT_EVENT_TYPES.contractDrift,
        aggregate: { type: 'agent_compatibility', id: current.id },
        occurredAt: clock.nowIso(),
        actor: { kind: 'system' },
        payload: {
          snapshotId: current.id,
          expectedDigest: current.digest,
          observedDigest,
          reason: 'live runtime identification differs from the compatible snapshot',
        },
      });
      deps.emit?.(envelope);
      return {
        ready: false,
        status: current.status,
        reason: 'Contract drift detected; privileged execution is disabled until reverify.',
        snapshot: current,
        driftDetected: true,
        missingMandatory,
        missingOptional: optionalMissing(current),
      };
    }

    return {
      ready: true,
      status: current.status,
      reason:
        current.status === 'COMPATIBLE'
          ? 'Agent runtime contract verified and current.'
          : 'Agent runtime contract verified with optional degradations.',
      snapshot: current,
      driftDetected: false,
      missingMandatory: [],
      missingOptional: optionalMissing(current),
    };
  }

  return { run };
}

function mandatoryMissing(snapshot: ContractSnapshot): string[] {
  return MANDATORY_CAPABILITIES.filter((name) => snapshot.capabilities[name] !== true);
}

function optionalMissing(snapshot: ContractSnapshot): string[] {
  return OPTIONAL_CAPABILITIES.filter((name) => snapshot.capabilities[name] !== true);
}

/** Compute the observed digest for a live identification against a snapshot. */
export function observedDigestFor(
  snapshot: ContractSnapshot,
  live: ProviderIdentification,
): string {
  return snapshotDigest({
    endpointIdentity: live.endpointIdentity,
    provider: live.provider,
    serverVersion: live.serverVersion,
    sdkPackage: live.sdkPackage,
    sdkVersion: live.sdkVersion,
    sdkIntegrity: live.sdkIntegrity,
    authMode: live.authMode,
    topology: live.topology,
    suiteVersion: snapshot.suiteVersion,
    capabilities: snapshot.capabilities,
    fatalProperties: snapshot.fatalProperties,
  });
}

/** Compare a live identification digest against the sealed snapshot digest. */
export function detectDigestDrift(
  snapshot: ContractSnapshot,
  live: ProviderIdentification,
): boolean {
  return snapshot.digest !== observedDigestFor(snapshot, live);
}

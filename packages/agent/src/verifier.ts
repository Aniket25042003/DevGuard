/**
 * C036 §9/§23 — the contract verifier: harmless read-only probes -> verified
 * capability matrix -> immutable snapshot -> persisted outcome.
 *
 * A verification run first checks for a current, fresh, operational snapshot
 * (idempotent reuse). Otherwise it identifies the runtime, runs the bounded
 * read-only probe suite, classifies every capability as verified/unverified,
 * detects FATAL properties (e.g. direct mutative GitHub tools), computes the
 * compatibility verdict, seals an immutable snapshot, and records it via the
 * append-only store. Unknown probe outcomes fail closed (capability unverified).
 * Nothing ever probes for privileged execution.
 */
import { isOperational, verdictToStatus, type CompatibilityStatus } from './compatibility.js';
import type { EventEnvelopeShape } from '@devguard/contracts';
import { makeError } from '@devguard/errors';
import { AGENT_EVENT_TYPES, makeAgentEvent } from './events.js';
import {
  classifyProviderError,
  normalizeIdentification,
  normalizeProbeResult,
  type ProviderErrorClassification,
} from './mapper.js';
import { evaluateCapabilities, type CapabilityVerdict } from './capabilities.js';
import {
  AGENT_CAPABILITY_SUITE_VERSION,
  contractSnapshotSchema,
  isSnapshotFresh,
  snapshotDigest,
  snapshotId,
  verificationRunKey,
  verifySnapshotIntegrity,
  type ContractSnapshot,
  type ProviderIdentification,
} from './snapshot.js';
import {
  VERIFICATION_PROBE_SUITE,
  type SnapshotStorePort,
  type RawProviderChannel,
} from './ports.js';
import { agentIdSchemas } from './ids.js';

export interface AgentClockPort {
  nowIso(): string;
  nowMs(): number;
}
export interface AgentIdPort {
  uuid(): string;
}

export type EmitAgentEvent = (envelope: EventEnvelopeShape) => void;

export interface ContractVerifierDeps {
  readonly channel: RawProviderChannel;
  readonly store: SnapshotStorePort;
  readonly clock?: AgentClockPort;
  readonly ids?: AgentIdPort;
  readonly emit?: EmitAgentEvent;
  /** Freshness window of a produced snapshot (ms). */
  readonly staleAfterMs?: number;
}

export interface ContactVerifierOptions {
  readonly force?: boolean;
  readonly actor?: { readonly kind: 'system' } | undefined;
}

export interface ContractVerifierResult {
  readonly snapshot: ContractSnapshot;
  readonly status: CompatibilityStatus;
  readonly verdict: CapabilityVerdict;
  /** True when a current fresh operational snapshot was reused (idempotent). */
  readonly reused: boolean;
  readonly runKey: string;
  readonly failures: readonly string[];
}

export const DEFAULT_SNAPSHOT_TTL_MS = 86_400_000;

export function createContractVerifier(deps: ContractVerifierDeps): {
  readonly verify: (opts?: ContactVerifierOptions) => Promise<ContractVerifierResult>;
} {
  const clock: AgentClockPort = deps.clock ?? {
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  const ids: AgentIdPort = deps.ids ?? { uuid: () => crypto.randomUUID() };
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_SNAPSHOT_TTL_MS;

  async function verify(opts: ContactVerifierOptions = {}): Promise<ContractVerifierResult> {
    const current = await deps.store.loadCurrent(deps.channel.endpointIdentity);
    // A persisted snapshot is only trusted as verification evidence after it
    // re-passed schema, digest, identity, and status-vs-capability verification.
    const integrity =
      current === undefined
        ? undefined
        : verifySnapshotIntegrity(current, deps.channel.endpointIdentity);
    if (
      !opts.force &&
      current !== undefined &&
      integrity?.valid === true &&
      isOperational(current.status) &&
      isSnapshotFresh(current, clock.nowMs())
    ) {
      return {
        snapshot: current,
        status: current.status,
        verdict: current.status === 'COMPATIBLE' ? 'COMPATIBLE' : 'DEGRADED',
        reused: true,
        runKey: verificationRunKey({
          endpointIdentity: current.endpointIdentity,
          serverVersion: current.serverVersion,
          sdkIntegrity: current.sdkIntegrity,
          suiteVersion: current.suiteVersion,
        }),
        failures: current.failureReasons,
      };
    }
    if (current !== undefined && integrity?.valid === false) {
      // Corrupted/tampered persistence must never silently fall through to a
      // fresh run without signalling: fail closed on the loaded evidence.
      deps.emit?.(
        verificationFailClosedEnvelope(
          `AGENT_SNAPSHOT_INTEGRITY_REJECTED:${integrity.failure}`,
          clock.nowIso(),
          deps.channel,
        ),
      );
    }

    // New verification run. Identify first (deterministic run key).
    let identification: ProviderIdentification;
    try {
      identification = normalizeIdentification(
        await deps.channel.identify(),
        deps.channel.endpointIdentity,
        deps.channel.provider,
      );
    } catch (err) {
      const classification = classifyOrThrow(err);
      deps.emit?.(verificationFailedEnvelope(classification, clock.nowIso(), deps.channel));
      throw classificationThrow(classification);
    }

    const runKey = verificationRunKey({
      endpointIdentity: identification.endpointIdentity,
      serverVersion: identification.serverVersion,
      sdkIntegrity: identification.sdkIntegrity,
      suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    });

    // Run the bounded read-only probe suite.
    const claims = new Map<string, boolean>();
    const probeFailures: string[] = [];
    for (const spec of VERIFICATION_PROBE_SUITE) {
      let raw: unknown;
      try {
        raw = await deps.channel.runProbe(spec);
      } catch {
        // A thrown probe fails closed: none of its capabilities are verified.
        for (const name of spec.capabilityNames) claims.set(name, false);
        probeFailures.push(`${spec.probe}:error`);
        continue;
      }
      const normalized = safeNormalizeProbeResult(raw);
      if (!normalized) {
        for (const name of spec.capabilityNames) claims.set(name, false);
        probeFailures.push(`${spec.probe}:schema`);
        continue;
      }
      for (const name of spec.capabilityNames) {
        claims.set(name, normalized.probeOk && normalized.verifiedCapabilities.includes(name));
      }
      for (const name of normalized.verifiedCapabilities) {
        if (!claims.has(name)) claims.set(name, normalized.probeOk);
      }
      if (!normalized.probeOk) probeFailures.push(`${spec.probe}:not_ok`);
    }

    let fatal: string[] = [];
    try {
      if (await deps.channel.detectsDirectMutativeGithubTools()) {
        fatal = ['direct_mutative_github_tools'];
      }
    } catch {
      // Unknown detection result is treated as present (fail closed).
      fatal = ['direct_mutative_github_tools'];
    }

    const evaluation = evaluateCapabilities(claims, fatal);
    const status = verdictToStatus(evaluation.verdict);

    const digest = snapshotDigest({
      endpointIdentity: identification.endpointIdentity,
      provider: identification.provider,
      serverVersion: identification.serverVersion,
      sdkPackage: identification.sdkPackage,
      sdkVersion: identification.sdkVersion,
      sdkIntegrity: identification.sdkIntegrity,
      authMode: identification.authMode,
      topology: identification.topology,
      suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
      capabilities: Object.fromEntries(claims),
      fatalProperties: fatal,
    });

    const verificationRunId = agentIdSchemas.verificationRunId.parse(ids.uuid());
    const failures = [
      ...probeFailures,
      ...evaluation.missingMandatory.map((name) => `missing:${name}`),
      ...evaluation.missingOptional.map((name) => `optional:${name}`),
      ...evaluation.fatalPresent,
      ...evaluation.unknownClaims.map((name) => `unknown:${name}`),
    ].slice(0, 64);

    const snapshot = contractSnapshotSchema.parse({
      id: snapshotId(digest, verificationRunId),
      verificationRunId,
      endpointIdentity: identification.endpointIdentity,
      provider: identification.provider,
      serverVersion: identification.serverVersion,
      sdkPackage: identification.sdkPackage,
      sdkVersion: identification.sdkVersion,
      sdkIntegrity: identification.sdkIntegrity,
      authMode: identification.authMode,
      topology: identification.topology,
      suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
      capabilities: Object.fromEntries(claims),
      fatalProperties: fatal,
      status,
      failureReasons: failures,
      checkedAt: clock.nowIso(),
      digest,
      staleAfterMs,
    });

    await deps.store.record(snapshot);
    deps.emit?.(
      outcomeEnvelope(snapshot, { actor: opts.actor ?? { kind: 'system' } }, clock.nowIso()),
    );
    return {
      snapshot,
      status,
      verdict: evaluation.verdict,
      reused: false,
      runKey,
      failures,
    };
  }

  return { verify };
}

function safeNormalizeProbeResult(raw: unknown) {
  try {
    return normalizeProbeResult(raw);
  } catch {
    return undefined;
  }
}

function classifyOrThrow(err: unknown): ProviderErrorClassification {
  return classifyProviderError(err);
}

function classificationThrow(cls: ProviderErrorClassification): Error {
  // Only codes that declare a detail schema may carry public details;
  // passing details to a schema-less code would make makeError throw.
  if (cls.code === 'AGENT_RESPONSE_SCHEMA_REJECTED') {
    return makeError(cls.code, {
      details: { kind: 'provider_response' },
      cause: cls.causeSanitized,
    });
  }
  if (cls.code === 'AGENT_AUTH_DENIED') {
    return makeError(cls.code, {
      details: { reason: cls.causeSanitized || 'provider failure' },
      cause: cls.causeSanitized,
    });
  }
  return makeError(cls.code, { cause: cls.causeSanitized });
}

function verificationFailedEnvelope(
  cls: ProviderErrorClassification,
  occurredAt: string,
  channel: RawProviderChannel,
): EventEnvelopeShape {
  return makeAgentEvent({
    type: AGENT_EVENT_TYPES.verificationFailed,
    aggregate: { type: 'agent_compatibility', id: channel.endpointIdentity.slice(0, 128) },
    occurredAt,
    actor: { kind: 'system' },
    payload: {
      provider: channel.provider,
      endpointIdentity: channel.endpointIdentity,
      errorCode: cls.code,
      detailSanitized: cls.causeSanitized,
    },
  });
}

/** Fail-closed event for rejected snapshot integrity (standardized error code). */
function verificationFailClosedEnvelope(
  detail: string,
  occurredAt: string,
  channel: RawProviderChannel,
): EventEnvelopeShape {
  return makeAgentEvent({
    type: AGENT_EVENT_TYPES.verificationFailed,
    aggregate: { type: 'agent_compatibility', id: channel.endpointIdentity.slice(0, 128) },
    occurredAt,
    actor: { kind: 'system' },
    payload: {
      provider: channel.provider,
      endpointIdentity: channel.endpointIdentity,
      errorCode: 'AGENT_SNAPSHOT_INTEGRITY_REJECTED',
      detailSanitized: detail.slice(0, 400),
    },
  });
}

function outcomeEnvelope(
  snapshot: ContractSnapshot,
  opts: { readonly actor: { readonly kind: 'system' } },
  occurredAt: string,
): EventEnvelopeShape {
  if (snapshot.status === 'INCOMPATIBLE') {
    return makeAgentEvent({
      type: AGENT_EVENT_TYPES.contractIncompatible,
      aggregate: { type: 'agent_compatibility', id: snapshot.id },
      occurredAt,
      actor: opts.actor,
      payload: {
        snapshotId: snapshot.id,
        provider: snapshot.provider,
        serverVersion: snapshot.serverVersion,
        missingMandatory: snapshot.failureReasons
          .filter((reason) => reason.startsWith('missing:'))
          .map((reason) => reason.slice('missing:'.length)),
        fatalPresent: snapshot.fatalProperties,
      },
    });
  }
  return makeAgentEvent({
    type: AGENT_EVENT_TYPES.capabilitiesVerified,
    aggregate: { type: 'agent_compatibility', id: snapshot.id },
    occurredAt,
    actor: opts.actor,
    payload: {
      snapshotId: snapshot.id,
      verificationRunId: snapshot.verificationRunId,
      provider: snapshot.provider,
      serverVersion: snapshot.serverVersion,
      status: snapshot.status,
      verifiedCapabilities: Object.entries(snapshot.capabilities)
        .filter(([, verified]) => verified)
        .map(([name]) => name),
      checkedAt: snapshot.checkedAt,
    },
  });
}

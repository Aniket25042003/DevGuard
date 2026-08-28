/**
 * C036 §12/§18 — contract snapshot model (append-only, immutable).
 *
 * A snapshot is immutable verification evidence. Snapshots are superseded but
 * never mutated; one active snapshot may exist per environment/provider
 * endpoint. Provider identification (endpoint identity, versions, integrity,
 * auth mode, topology) plus the verified capability set and the resulting
 * compatibility status are sealed behind a deterministic digest. Secrets are
 * never part of a snapshot.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { agentIdSchemas, type ContractSnapshotId } from './ids.js';
import { COMPATIBILITY_STATUSES, type CompatibilityStatus } from './compatibility.js';
import { evaluateCapabilities } from './capabilities.js';
import { verdictToStatus } from './compatibility.js';

export const AGENT_CAPABILITY_SUITE_VERSION = 1 as const;

const hexSha = z.string().regex(/^[0-9a-f]{64}$/);
const bounded = z.string().min(1).max(200);

export const providerIdentificationSchema = z
  .object({
    endpointIdentity: z.string().min(1).max(256),
    provider: z.string().min(1).max(64),
    serverVersion: z.string().min(1).max(128),
    sdkPackage: z.string().min(1).max(128).optional(),
    sdkVersion: z.string().min(1).max(128).optional(),
    sdkIntegrity: hexSha.optional(),
    authMode: z.enum(['server_secret', 'oauth', 'mtls']).optional(),
    topology: z.enum(['hosted', 'local', 'shared']).optional(),
  })
  .strict();

export interface ProviderIdentification {
  readonly endpointIdentity: string;
  readonly provider: string;
  readonly serverVersion: string;
  readonly sdkPackage?: string | undefined;
  readonly sdkVersion?: string | undefined;
  readonly sdkIntegrity?: string | undefined;
  readonly authMode?: 'server_secret' | 'oauth' | 'mtls' | undefined;
  readonly topology?: 'hosted' | 'local' | 'shared' | undefined;
}

export const contractSnapshotSchema = z
  .object({
    id: agentIdSchemas.contractSnapshotId,
    verificationRunId: agentIdSchemas.verificationRunId,
    endpointIdentity: z.string().min(1).max(256),
    provider: z.string().min(1).max(64),
    serverVersion: z.string().min(1).max(128),
    sdkPackage: z.string().min(1).max(128).optional(),
    sdkVersion: z.string().min(1).max(128).optional(),
    sdkIntegrity: hexSha.optional(),
    authMode: z.enum(['server_secret', 'oauth', 'mtls']).optional(),
    topology: z.enum(['hosted', 'local', 'shared']).optional(),
    suiteVersion: z.literal(AGENT_CAPABILITY_SUITE_VERSION),
    capabilities: z.record(z.string().min(1).max(64), z.boolean()),
    fatalProperties: z.array(z.string().min(1).max(64)).default([]),
    status: z.enum(COMPATIBILITY_STATUSES),
    failureReasons: z.array(bounded).default([]),
    checkedAt: z.string(),
    digest: hexSha,
    staleAfterMs: z.number().int().positive(),
  })
  .strict();

export interface ContractSnapshot {
  readonly id: ContractSnapshotId;
  readonly verificationRunId: ReturnType<typeof agentIdSchemas.verificationRunId.parse>;
  readonly endpointIdentity: string;
  readonly provider: string;
  readonly serverVersion: string;
  readonly sdkPackage?: string | undefined;
  readonly sdkVersion?: string | undefined;
  readonly sdkIntegrity?: string | undefined;
  readonly authMode?: 'server_secret' | 'oauth' | 'mtls' | undefined;
  readonly topology?: 'hosted' | 'local' | 'shared' | undefined;
  readonly suiteVersion: typeof AGENT_CAPABILITY_SUITE_VERSION;
  /** Verified capability name -> verified boolean (only true claims count). */
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly fatalProperties: readonly string[];
  readonly status: CompatibilityStatus;
  readonly failureReasons: readonly string[];
  readonly checkedAt: string;
  readonly digest: string;
  /** Freshness window; beyond this the snapshot is stale and must reverify. */
  readonly staleAfterMs: number;
}

/** Deterministic RFC-8785-subset canonical JSON for digest input. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Deterministic digest over the identity + capability-bearing fields. */
export function snapshotDigest(shape: {
  readonly endpointIdentity: string;
  readonly provider: string;
  readonly serverVersion: string;
  readonly sdkPackage?: string | undefined;
  readonly sdkVersion?: string | undefined;
  readonly sdkIntegrity?: string | undefined;
  readonly authMode?: string | undefined;
  readonly topology?: string | undefined;
  readonly suiteVersion: number;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly fatalProperties: readonly string[];
}): string {
  return sha256Hex(canonicalize(shape));
}

/** Idempotency key: endpoint identity + server version + SDK integrity + suite. */
export function verificationRunKey(shape: {
  readonly endpointIdentity: string;
  readonly serverVersion: string;
  readonly sdkIntegrity?: string | undefined;
  readonly suiteVersion: number;
}): string {
  return sha256Hex(canonicalize(shape));
}

/**
 * Unique immutable snapshot id: content digest bound to the verification run.
 * Re-running identical verification produces a distinct, append-only snapshot.
 */
export function snapshotId(digest: string, verificationRunId: string): string {
  return sha256Hex(`${digest}:${verificationRunId}`);
}

export function isSnapshotFresh(snapshot: ContractSnapshot, nowMs: number): boolean {
  const checkedAt = Date.parse(snapshot.checkedAt);
  if (Number.isNaN(checkedAt)) return false;
  const age = nowMs - checkedAt;
  return age >= 0 && age <= snapshot.staleAfterMs;
}

/** A snapshot rejected by load-time integrity verification (fail closed). */
export type SnapshotIntegrityFailure =
  'schema_invalid' | 'digest_mismatch' | 'identity_mismatch' | 'status_mismatch';

export interface SnapshotIntegrityVerdict {
  readonly valid: boolean;
  readonly failure?: SnapshotIntegrityFailure | undefined;
}

/**
 * Re-verify a snapshot that arrived from the persistence layer (or was read
 * from disk) BEFORE it can be treated as trusted verification evidence. Runs
 * the sealed schema parse, recomputes the deterministic digest, compares the
 * sealed identity against the endpoint binding, and confirms the stored status
 * agrees with a fresh capability evaluation. Corruption or tampering therefore
 * cannot surface COMPATIBLE evidence or enable readiness on modified claims.
 */
export function verifySnapshotIntegrity(
  snapshot: unknown,
  expectedEndpointIdentity?: string,
): SnapshotIntegrityVerdict {
  const parsed = contractSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return { valid: false, failure: 'schema_invalid' };
  const value = parsed.data;
  // Recompute the digest over the EXACT same reduced identity+capability shape
  // the verifier sealed it from (not the full snapshot record).
  const digest = snapshotDigest({
    endpointIdentity: value.endpointIdentity,
    provider: value.provider,
    serverVersion: value.serverVersion,
    sdkPackage: value.sdkPackage,
    sdkVersion: value.sdkVersion,
    sdkIntegrity: value.sdkIntegrity,
    authMode: value.authMode,
    topology: value.topology,
    suiteVersion: value.suiteVersion,
    capabilities: value.capabilities,
    fatalProperties: value.fatalProperties,
  });
  if (digest !== value.digest) return { valid: false, failure: 'digest_mismatch' };
  if (
    expectedEndpointIdentity !== undefined &&
    value.endpointIdentity !== expectedEndpointIdentity
  ) {
    return { valid: false, failure: 'identity_mismatch' };
  }
  const evaluation = evaluateCapabilities(
    new Map(Object.entries(value.capabilities)),
    value.fatalProperties,
  );
  if (verdictToStatus(evaluation.verdict) !== value.status) {
    return { valid: false, failure: 'status_mismatch' };
  }
  return { valid: true };
}

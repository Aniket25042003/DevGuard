import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITY_SUITE_VERSION,
  contractSnapshotSchema,
  isSnapshotFresh,
  snapshotDigest,
  snapshotId,
  verificationRunKey,
  type ContractSnapshot,
} from './snapshot.js';
import { COMPATIBILITY_STATUSES } from './compatibility.js';

const baseShape = {
  endpointIdentity: 'https://trueforge.example:8443',
  provider: 'trueforge',
  serverVersion: '2026.08.1',
  sdkPackage: '@truefoundry/trueforge-sdk',
  sdkVersion: '1.2.3',
  sdkIntegrity: 'a'.repeat(64),
  authMode: 'server_secret' as const,
  topology: 'hosted' as const,
  suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
  capabilities: { session_create: true, turn_create: true },
  fatalProperties: [] as string[],
};

function fullSnapshot(overrides: Partial<ContractSnapshot> = {}): ContractSnapshot {
  const digest = snapshotDigest(baseShape);
  const base: ContractSnapshot = {
    id: snapshotId(digest, 'run-1') as ContractSnapshot['id'],
    verificationRunId:
      'a1b2c3d4-0000-4000-8000-000000000001' as ContractSnapshot['verificationRunId'],
    endpointIdentity: baseShape.endpointIdentity,
    provider: baseShape.provider,
    serverVersion: baseShape.serverVersion,
    sdkPackage: baseShape.sdkPackage,
    sdkVersion: baseShape.sdkVersion,
    sdkIntegrity: baseShape.sdkIntegrity,
    authMode: baseShape.authMode,
    topology: baseShape.topology,
    suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    capabilities: baseShape.capabilities,
    fatalProperties: [],
    status: 'COMPATIBLE',
    failureReasons: [],
    checkedAt: '2026-08-27T00:00:00.000Z',
    digest,
    staleAfterMs: 86_400_000,
  };
  return { ...base, ...overrides };
}

describe('C036 contract snapshot model', () => {
  it('computes a deterministic, order-independent digest that changes with capabilities', () => {
    const one = snapshotDigest({ ...baseShape, capabilities: { session_create: true } });
    const twoOrderA = snapshotDigest({
      ...baseShape,
      capabilities: { session_create: true, turn_create: true },
    });
    const twoOrderB = snapshotDigest({
      ...baseShape,
      capabilities: { turn_create: true, session_create: true },
    });
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(twoOrderA).toBe(twoOrderB); // key order does not matter
    expect(one).not.toBe(twoOrderA); // capability set changes the digest
  });

  it('verification run key is deterministic over identity and version', () => {
    const key = verificationRunKey({
      endpointIdentity: baseShape.endpointIdentity,
      serverVersion: baseShape.serverVersion,
      sdkIntegrity: baseShape.sdkIntegrity,
      suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const other = verificationRunKey({
      endpointIdentity: baseShape.endpointIdentity,
      serverVersion: 'different',
      sdkIntegrity: baseShape.sdkIntegrity,
      suiteVersion: AGENT_CAPABILITY_SUITE_VERSION,
    });
    expect(other).not.toBe(key);
  });

  it('snapshot id binds digest to a unique run id', () => {
    expect(snapshotId('d'.repeat(64), 'run-a')).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotId('d'.repeat(64), 'run-a')).not.toBe(snapshotId('d'.repeat(64), 'run-b'));
  });

  it('round-trips a full snapshot through the strict schema', () => {
    const snapshot = fullSnapshot();
    const parsed = contractSnapshotSchema.parse(snapshot);
    expect(parsed.status).toBe('COMPATIBLE');
    expect(parsed.id).toBe(snapshot.id);
    expect(() => contractSnapshotSchema.parse({ ...snapshot, status: 'NOT_A_STATUS' })).toThrow();
  });

  for (const status of COMPATIBILITY_STATUSES) {
    it(`accepts status '${status}' in the schema`, () => {
      expect(contractSnapshotSchema.parse(fullSnapshot({ status })).status).toBe(status);
    });
  }

  it('isSnapshotFresh respects the staleness window', () => {
    const snapshot = fullSnapshot({ checkedAt: '2026-08-27T00:00:00.000Z', staleAfterMs: 60_000 });
    expect(isSnapshotFresh(snapshot, Date.parse('2026-08-27T00:00:59.000Z'))).toBe(true);
    expect(isSnapshotFresh(snapshot, Date.parse('2026-08-27T00:01:01.000Z'))).toBe(false);
  });

  it('rejects an unparseable checkedAt as stale', () => {
    const snapshot = fullSnapshot({ checkedAt: 'not-a-date' });
    expect(isSnapshotFresh(snapshot, Date.now())).toBe(false);
  });
});

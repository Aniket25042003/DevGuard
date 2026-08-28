import { describe, expect, it } from 'vitest';
import { parseEvent } from '@devguard/contracts';
import { AGENT_EVENT_TYPES, makeAgentEvent } from './events.js';

const SNAPSHOT_ID = 'a'.repeat(64);
const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('C036 agent events (C004 canonical parity)', () => {
  it('emits agent events that the canonical parseEvent registry accepts', () => {
    const envelope = makeAgentEvent({
      type: AGENT_EVENT_TYPES.capabilitiesVerified,
      aggregate: { type: 'agent_compatibility', id: SNAPSHOT_ID },
      occurredAt: '2026-08-27T00:00:00.000Z',
      actor: { kind: 'system' },
      payload: {
        snapshotId: SNAPSHOT_ID,
        verificationRunId: RUN_ID,
        provider: 'trueforge',
        serverVersion: '2026.08.1',
        status: 'COMPATIBLE',
        verifiedCapabilities: ['session_create'],
        checkedAt: '2026-08-27T00:00:00.000Z',
      },
    });
    const parsed = parseEvent(envelope);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.type).toBe(AGENT_EVENT_TYPES.capabilitiesVerified);
  });

  it('registers every catalogued agent event type in the canonical registry', () => {
    for (const type of Object.values(AGENT_EVENT_TYPES)) {
      // Building without the type being registered would throw; a successful
      // build + parse confirms the type is known to canonical consumers.
      const envelope = makeAgentEvent({
        type,
        aggregate: { type: 'agent_compatibility', id: SNAPSHOT_ID },
        occurredAt: '2026-08-27T00:00:00.000Z',
        actor: { kind: 'system' },
        payload:
          type === AGENT_EVENT_TYPES.capabilitiesVerified
            ? {
                snapshotId: SNAPSHOT_ID,
                verificationRunId: RUN_ID,
                provider: 'trueforge',
                serverVersion: '2026.08.1',
                status: 'COMPATIBLE',
                verifiedCapabilities: ['session_create'],
                checkedAt: '2026-08-27T00:00:00.000Z',
              }
            : type === AGENT_EVENT_TYPES.contractIncompatible
              ? {
                  snapshotId: SNAPSHOT_ID,
                  provider: 'trueforge',
                  serverVersion: '2026.08.1',
                  missingMandatory: [],
                  fatalPresent: [],
                }
              : type === AGENT_EVENT_TYPES.contractDrift
                ? {
                    snapshotId: SNAPSHOT_ID,
                    expectedDigest: 'b'.repeat(64),
                    observedDigest: 'c'.repeat(64),
                    reason: 'drift',
                  }
                : type === AGENT_EVENT_TYPES.unavailable
                  ? {
                      provider: 'trueforge',
                      endpointIdentity: 'https://trueforge.example:8443',
                      reason: 'down',
                    }
                  : {
                      provider: 'trueforge',
                      endpointIdentity: 'https://trueforge.example:8443',
                      errorCode: 'AGENT_AUTH_DENIED',
                      detailSanitized: 'denied',
                    },
      });
      expect(parseEvent(envelope).ok).toBe(true);
    }
  });
});

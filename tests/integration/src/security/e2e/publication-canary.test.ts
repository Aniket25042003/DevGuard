import { describe, expect, it } from 'vitest';
import { PublicationGuard, SensitiveDataGuard } from '@devguard/security';
import { runScenario, type ScenarioSpec } from './harness.js';

const CANARY = 'cat-canary-9f4b7d12e0';

const E11_SPEC: ScenarioSpec = {
  id: 'e11_publication_canary',
  version: '1.0.0',
  tags: ['secrets', 'publication'],
  description: 'a synthetic secret can never be published; publication fails closed',
};

describe('C097 E11 publication canary gate', () => {
  it('blocks publishing a secret, stays clean when redacted, and fails closed on outage', async () => {
    const guard = new SensitiveDataGuard({});
    const publication = new PublicationGuard(guard);
    guard.registerExactSecret(CANARY);

    let rawPublished = false;
    const { evidence } = await runScenario(
      E11_SPEC,
      async () => {
        const states: string[] = [];

        // 1) Publishing raw content that contains the canary must be blocked.
        const leakyBlob = `pr body with ${CANARY} inline`;
        const leakScan = await publication.scanForLeaks('pr', 'pr-1', leakyBlob);
        expect(leakScan.status).toBe('findings_present');
        try {
          publication.assertPublishable(leakScan, leakyBlob);
          rawPublished = true;
        } catch (error) {
          expect((error as { code?: string }).code).toBe('PUBLICATION_BLOCKED');
          states.push('blocked_canary');
        }

        // 2) The redacted projection must not contain the raw canary.
        const redacted = guard.redact(leakyBlob, 'api');
        expect(redacted.value).not.toContain(CANARY);
        states.push(redacted.value.includes('[REDACTED]') ? 'redacted' : 'unredacted');

        // 3) Clean content is publishable against a fresh, digest-bound scan.
        const cleanBlob = 'ordinary release notes without secrets';
        const cleanScan = await publication.scanForLeaks('pr', 'pr-2', cleanBlob);
        expect(cleanScan.status).toBe('clean');
        publication.assertPublishable(cleanScan, cleanBlob);
        states.push('published_clean');

        // 4) Scanner outage fails CLOSED even for clean content.
        publication.setScannerAvailability(false);
        const outageScan = await publication.scanForLeaks('pr', 'pr-3', cleanBlob);
        expect(outageScan.status).toBe('scanner_unavailable');
        try {
          publication.assertPublishable(outageScan, cleanBlob);
          states.push('outage_published');
        } catch (error) {
          expect((error as { code?: string }).code).toBe('PUBLICATION_BLOCKED');
          states.push('outage_blocked');
        }

        return {
          states,
          evidence: [redacted.value, cleanBlob],
        };
      },
      {
        forbiddenEffects: [
          {
            id: 'no_raw_secret_publication',
            description: 'the canary must never be published raw',
            evaluate: () => rawPublished,
          },
        ],
        canaries: [CANARY],
      },
    );

    expect(evidence.passed).toBe(true);
    expect(evidence.canaryLeaks).toEqual([]);
    expect(evidence.states).toContain('blocked_canary');
    expect(evidence.states).toContain('redacted');
    expect(evidence.states).toContain('published_clean');
    expect(evidence.states).toContain('outage_blocked');
    expect(evidence.states).not.toContain('outage_published');
  });
});

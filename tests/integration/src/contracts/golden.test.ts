import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listRegisteredEventTypes, parseEvent } from '@devguard/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixtures = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'tests/integration/src/contracts/fixtures/golden-events.json'),
    'utf8',
  ),
) as {
  golden: Array<Record<string, unknown>>;
  legacyMustQuarantine: Array<Record<string, unknown>>;
};

describe('C004 golden fixture compatibility', () => {
  it('every registered event type has stable registry coverage', () => {
    const types = listRegisteredEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(20);
    // Families required by M0/M1 consumers:
    for (const required of [
      'configuration.validated',
      'authorization.denied',
      'repository.connected',
      'workflow.queued',
      'action.proposed',
      'policy.decision.recorded',
      'approval.required',
      'validation.completed',
      'artifact.created',
      'webhook.accepted',
      'outbox.recorded',
    ]) {
      expect(types, `${required} must stay registered`).toContain(required);
    }
  });

  it('golden envelopes keep parsing (additive evolution guard)', () => {
    for (const envelope of fixtures.golden) {
      const parsed = parseEvent(structuredClone(envelope));
      expect(parsed.ok, JSON.stringify(parsed).slice(0, 300)).toBe(true);
    }
  });

  it('legacy/pre-v1 shapes are quarantined, not coerced', () => {
    for (const legacy of fixtures.legacyMustQuarantine) {
      const parsed = parseEvent(legacy);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(['invalid_envelope', 'unknown_type']).toContain(parsed.reason);
    }
  });
});

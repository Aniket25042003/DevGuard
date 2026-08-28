import { describe, expect, it } from 'vitest';
import { fakeClock, runScenario, type ScenarioSpec } from './harness.js';

const SPEC: ScenarioSpec = {
  id: 'selftest',
  version: '1.0.0',
  tags: ['harness'],
  description: 'harness self-test',
};

describe('C097 scenario harness', () => {
  it('advances a deterministic fake clock', () => {
    const clock = fakeClock();
    const before = clock.now().toISOString();
    clock.advance(1_000);
    expect(clock.now().toISOString()).toBe(new Date(Date.parse(before) + 1_000).toISOString());
  });

  it('passes when no forbidden effect or canary leak is observed', async () => {
    const { evidence } = await runScenario(
      SPEC,
      async () => ({ states: ['seeded', 'done'], evidence: ['safe output'] }),
      { forbiddenEffects: [], canaries: ['canary-1'] },
    );
    expect(evidence.passed).toBe(true);
    expect(evidence.forbiddenViolations).toEqual([]);
    expect(evidence.canaryLeaks).toEqual([]);
  });

  it('fails when a forbidden effect fires', async () => {
    const { evidence } = await runScenario(
      SPEC,
      async () => ({ states: ['acted'], evidence: [] }),
      {
        forbiddenEffects: [
          { id: 'no_merge', description: 'merge must not happen', evaluate: () => true },
        ],
        canaries: [],
      },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.forbiddenViolations).toEqual(['no_merge']);
  });

  it('fails when a synthetic canary leaks into captured evidence', async () => {
    const { evidence } = await runScenario(
      SPEC,
      async () => ({ states: ['done'], evidence: ['leaked canary-secret-abc here'] }),
      { forbiddenEffects: [], canaries: ['canary-secret-abc'] },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.canaryLeaks).toEqual(['canary-secret-abc']);
  });
});

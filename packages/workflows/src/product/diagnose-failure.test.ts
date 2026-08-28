import { describe, expect, it } from 'vitest';
import {
  DIAGNOSE_FAILURE_STEPS,
  DIAGNOSE_FAILURE_ALLOWED_ACTIONS,
  validateDefinition,
} from './diagnose-failure.js';

describe('C050 diagnose_failure product workflow definition', () => {
  it('is a bounded, fail-closed definition requiring reproduction', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(
      DIAGNOSE_FAILURE_STEPS.some((s) => s.actionTypes.includes('action:sandbox_reproduce')),
    ).toBe(true);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(DIAGNOSE_FAILURE_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(DIAGNOSE_FAILURE_ALLOWED_ACTIONS).toContain(action);
  });

  it('validates (rerun/regressions) before any push', () => {
    const kinds = DIAGNOSE_FAILURE_STEPS.map((s) => s.kind);
    const pushIndex = kinds.indexOf('published');
    expect(kinds.slice(0, pushIndex).includes('command')).toBe(true);
    expect(DIAGNOSE_FAILURE_STEPS[pushIndex].id).toBe('push_evidence');
  });
});

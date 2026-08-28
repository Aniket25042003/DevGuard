import { describe, expect, it } from 'vitest';
import {
  REVIEW_REMEDIATION_STEPS,
  REVIEW_REMEDIATION_ALLOWED_ACTIONS,
  REVIEW_REMEDIATION_CYCLE_BUDGET,
  validateDefinition,
} from './review-remediation.js';

describe('C054 review_remediation product workflow definition', () => {
  it('is a bounded, fail-closed definition with a positive cycle budget', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(REVIEW_REMEDIATION_CYCLE_BUDGET).toBeGreaterThan(0);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(REVIEW_REMEDIATION_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(REVIEW_REMEDIATION_ALLOWED_ACTIONS).toContain(action);
  });

  it('validation precedes any push and re-review is the last, stop-only step', () => {
    const kinds = REVIEW_REMEDIATION_STEPS.map((s) => s.kind);
    const pushIndex = kinds.indexOf('published');
    expect(kinds.slice(0, pushIndex).includes('command')).toBe(true); // validate before push
    expect(REVIEW_REMEDIATION_STEPS[kinds.length - 1].id).toBe('rereview');
    expect(REVIEW_REMEDIATION_STEPS[kinds.length - 1].failureBehavior).toBe('stop');
  });
});

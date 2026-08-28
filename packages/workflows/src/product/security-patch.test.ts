import { describe, expect, it } from 'vitest';
import {
  SECURITY_PATCH_STEPS,
  SECURITY_PATCH_ALLOWED_ACTIONS,
  validateDefinition,
} from './security-patch.js';

describe('C052 security_patch product workflow definition', () => {
  it('is a bounded, fail-closed definition requiring absence proof and no merge', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(SECURITY_PATCH_ALLOWED_ACTIONS).not.toContain('action:merge_pr');
  });

  it('requires a comparable re-scan and finding-identity absence proof', () => {
    const allValidators = new Set(SECURITY_PATCH_STEPS.flatMap((s) => s.validatorIds));
    expect(allValidators.has('v_rescan_coverage')).toBe(true);
    expect(allValidators.has('v_finding_absent')).toBe(true);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(SECURITY_PATCH_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(SECURITY_PATCH_ALLOWED_ACTIONS).toContain(action);
  });
});

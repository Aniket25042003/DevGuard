import { describe, expect, it } from 'vitest';
import {
  SECURITY_AUDIT_STEPS,
  SECURITY_AUDIT_ALLOWED_ACTIONS,
  validateDefinition,
} from './security-audit.js';

describe('C051 security_audit product workflow definition', () => {
  it('is a bounded, fail-closed, non-mutating definition', () => {
    expect(validateDefinition().ok).toBe(true);
  });

  it('never allows commit/push/merge (non-mutating)', () => {
    for (const m of ['action:commit', 'action:push_branch', 'action:merge_pr']) {
      expect(SECURITY_AUDIT_ALLOWED_ACTIONS).not.toContain(m);
    }
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(SECURITY_AUDIT_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(SECURITY_AUDIT_ALLOWED_ACTIONS).toContain(action);
  });
});

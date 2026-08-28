import { describe, expect, it } from 'vitest';
import { findActionDefinition } from '../../../policy-engine/src/actions/catalog.js';
import {
  IMPLEMENT_ISSUE_STEPS,
  IMPLEMENT_ISSUE_ALLOWED_ACTIONS,
  implementIssueDefinition,
  validateDefinition,
} from './implement-issue.js';

describe('C049 implement_issue product workflow definition', () => {
  it('is a bounded, approval-gated, fail-closed definition', () => {
    expect(validateDefinition().ok).toBe(true);
  });

  it('every declared action resolves through the canonical policy catalog', () => {
    const used = new Set(IMPLEMENT_ISSUE_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) {
      expect(IMPLEMENT_ISSUE_ALLOWED_ACTIONS).toContain(action);
      expect(findActionDefinition(action)).toBeDefined();
    }
  });

  it('orders evidence-bearing stages before any publish/merge', () => {
    const kinds = IMPLEMENT_ISSUE_STEPS.map((s) => s.kind);
    const firstPublish = kinds.findIndex((k) => k === 'published');
    const hasValidation = kinds.slice(0, firstPublish).includes('command');
    expect(hasValidation).toBe(true);
    // Merge is the last published step and requires a prior approval.
    expect(implementIssueDefinition.steps[kinds.length - 1].id).toBe('merge');
    expect(kinds.includes('approval')).toBe(true);
  });
});

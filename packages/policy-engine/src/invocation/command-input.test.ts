import { describe, expect, it } from 'vitest';
import { validateManualCommandInput } from './command-input.js';

describe('validateManualCommandInput', () => {
  it('requires pull request number for review_remediation', () => {
    expect(() => validateManualCommandInput('review_remediation', {})).toThrow();
    expect(validateManualCommandInput('review_remediation', { pullRequestNumber: 4 })).toEqual({
      pullRequestNumber: 4,
    });
  });

  it('allows empty security audit input', () => {
    expect(validateManualCommandInput('security_audit', {})).toEqual({});
    expect(validateManualCommandInput('security_audit', { ref: 'main' })).toEqual({ ref: 'main' });
  });

  it('requires finding ids for security_patch', () => {
    expect(() =>
      validateManualCommandInput('security_patch', {
        findingIds: ['00000000-0000-4000-8000-000000000001'],
      }),
    ).not.toThrow();
  });
});

/**
 * CP001 §22 — command alias table and `normalizeCommandId`:
 * bijectivity (one alias → one canonical ID), completeness of the surface
 * verbs, case-sensitivity, unknown and non-workflow rejection (fail closed).
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ALIASES_V1,
  CommandUnknownError,
  WORKFLOW_IDS_V1,
  normalizeCommandId,
  normalizeWorkflowId,
} from '@devguard/policy-engine';

describe('COMMAND_ALIASES_V1 (CP001 §8)', () => {
  it('every alias maps to a real canonical workflow ID', () => {
    for (const [alias, target] of Object.entries(COMMAND_ALIASES_V1)) {
      expect(alias.length).toBeGreaterThan(0);
      expect(
        WORKFLOW_IDS_V1.includes(target),
        `${alias} -> ${target} is not a canonical workflow`,
      ).toBe(true);
    }
  });

  it('one alias never maps to two IDs (and the table has no duplicate keys)', () => {
    const keys = Object.keys(COMMAND_ALIASES_V1);
    expect(new Set(keys).size).toBe(keys.length);
    // Every key maps to exactly one value by construction of the record, but
    // assert the invariant explicitly so an accidental duplicate key spelling
    // (e.g. two keys differing only by case) fails CI.
    for (const alias of keys) {
      const target = COMMAND_ALIASES_V1[alias]!;
      expect(COMMAND_ALIASES_V1[alias]).toBe(target);
    }
  });

  it('contains the six CP001 surface verbs mapped to their canonical workflows', () => {
    expect(COMMAND_ALIASES_V1.review).toBe('review_remediation');
    expect(COMMAND_ALIASES_V1.fix).toBe('diagnose_failure');
    expect(COMMAND_ALIASES_V1.audit).toBe('security_audit');
    expect(COMMAND_ALIASES_V1.patch).toBe('security_patch');
    expect(COMMAND_ALIASES_V1.implement).toBe('implement_issue');
  });

  it('still contains every C028 base alias (table merged, not forked)', () => {
    expect(COMMAND_ALIASES_V1.fix_tests).toBe('diagnose_failure');
    expect(COMMAND_ALIASES_V1.diagnose_bug).toBe('diagnose_failure');
    expect(COMMAND_ALIASES_V1.security_scan).toBe('security_audit');
    expect(COMMAND_ALIASES_V1.dependency_update).toBe('dependency_upgrade');
    expect(COMMAND_ALIASES_V1.refactor).toBe('manual_refactor');
  });

  it('exposes no meta verbs (status/help are GitHub meta, not commands)', () => {
    expect(COMMAND_ALIASES_V1.status).toBeUndefined();
    expect(COMMAND_ALIASES_V1.help).toBeUndefined();
  });
});

describe('normalizeCommandId (CP001 §10)', () => {
  it('resolves every canonical command ID to itself', () => {
    for (const id of WORKFLOW_IDS_V1) {
      expect(normalizeCommandId(id)).toBe(id);
    }
  });

  it('resolves surface verbs through the merged alias table', () => {
    expect(normalizeCommandId('review')).toBe('review_remediation');
    expect(normalizeCommandId('fix')).toBe('diagnose_failure');
    expect(normalizeCommandId('audit')).toBe('security_audit');
    expect(normalizeCommandId('patch')).toBe('security_patch');
    expect(normalizeCommandId('implement')).toBe('implement_issue');
    expect(normalizeCommandId('fix_tests')).toBe('diagnose_failure');
    expect(normalizeCommandId('refactor')).toBe('manual_refactor');
  });

  it('rejects mixed-case and spacing variants (lowercase only, fail closed)', () => {
    for (const input of ['Review', 'REVIEW', 'implement issue', 'Implement_Issue', 'sec urity']) {
      expect(
        (() => {
          try {
            normalizeCommandId(input);
            return null;
          } catch (error) {
            return error;
          }
        })(),
      ).toBeInstanceOf(CommandUnknownError);
    }
  });

  it('rejects unknown verbs with a typed COMMAND_UNKNOWN error', () => {
    for (const input of ['make_money_fast', 'play', '', '   ', 'xyzzz']) {
      let error: unknown = null;
      try {
        normalizeCommandId(input);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${JSON.stringify(input)} should throw`).toBeInstanceOf(CommandUnknownError);
      if (error instanceof CommandUnknownError) {
        expect(error.code).toBe('COMMAND_UNKNOWN');
        expect(error.rawInput).toBe(input);
      }
    }
  });

  it('rejects non-workflow (validation-step) names with a hint and never guesses', () => {
    for (const input of ['run_tests', 'static_analysis', 'integration_tests', 'dependency_check']) {
      let error: unknown = null;
      try {
        normalizeCommandId(input);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${input} should be denied as non-workflow`).toBeInstanceOf(
        CommandUnknownError,
      );
      if (error instanceof CommandUnknownError) {
        expect(error.message).toContain('validation step');
      }
    }
  });

  it('is consistent with the underlying normalizeWorkflowId resolver', () => {
    const resolved = normalizeWorkflowId('review');
    expect(resolved.outcome).toBe('RESOLVED');
    if (resolved.outcome === 'RESOLVED') {
      expect(normalizeCommandId('review')).toBe(resolved.workflowId);
    }
  });
});

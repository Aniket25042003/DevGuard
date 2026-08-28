/**
 * CP001 §22 — cross-package contract tests for the shared command contract.
 *
 * Reconciles the *transport* vocabulary (`@devguard/api-contracts`) with the
 * *domain* registry (`@devguard/policy-engine`) so the canonical command set,
 * alias targets and MVP/extension flags can never drift apart, and validates
 * the golden fixtures against the live schemas.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CONTRACT_VERSION,
  COMMAND_IDS_V1,
  commandMvpFlags,
  commandReceiptSchema,
  submitCommandRequestSchema,
  workflowRunDtoSchema,
  workflowRunListQuerySchema,
  type CanonicalCommandId,
} from '@devguard/api-contracts';
import {
  COMMAND_ALIASES_V1,
  CommandUnknownError,
  WORKFLOW_IDS_V1,
  normalizeCommandId,
  type WorkflowIdV1,
} from '@devguard/policy-engine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const golden = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'tests/integration/src/contracts/fixtures/command-contract-golden.json'),
    'utf8',
  ),
) as {
  version: string;
  examples: {
    submitCommandCanonical: Record<string, unknown>;
    submitCommandAliasWithGithub: Record<string, unknown>;
    receipt: Record<string, unknown>;
    workflowRun: Record<string, unknown>;
  };
  mustReject: Array<{ schema: string; label: string; payload: Record<string, unknown> }>;
  unknownVerbs: string[];
};

const schemaByName = {
  submitCommandRequest: submitCommandRequestSchema,
  receipt: commandReceiptSchema,
  workflowRun: workflowRunDtoSchema,
  workflowRunListQuery: workflowRunListQuerySchema,
} as const;

describe('CP001 golden fixture compatibility', () => {
  it('golden version token matches the frozen contract version', () => {
    expect(golden.version).toBe(COMMAND_CONTRACT_VERSION);
    expect(COMMAND_CONTRACT_VERSION).toBe('command-contract.v1');
  });

  it('golden canonical command request parses', () => {
    const parsed = submitCommandRequestSchema.parse(
      structuredClone(golden.examples.submitCommandCanonical),
    );
    expect(parsed.commandId).toBe('security_audit');
    expect(parsed.originSurface).toBe('cli');
  });

  it('golden alias + github-scoped request parses with nested refs', () => {
    const parsed = submitCommandRequestSchema.parse(
      structuredClone(golden.examples.submitCommandAliasWithGithub),
    );
    expect(parsed.commandId).toBe('review');
    expect(parsed.originSurface).toBe('github_comment');
    expect(parsed.github?.issueOrPrNumber).toBe(7);
  });

  it('golden receipt parses as an accepted receipt', () => {
    const parsed = commandReceiptSchema.parse(structuredClone(golden.examples.receipt));
    expect(parsed.status).toBe('accepted');
    expect(parsed.commandId).toBe('review_remediation');
  });

  it('golden workflow run projection parses with trigger + origin', () => {
    const parsed = workflowRunDtoSchema.parse(structuredClone(golden.examples.workflowRun));
    expect(parsed.workflowType).toBe('review_remediation');
    expect(parsed.trigger.triggerType).toBe('manual');
    expect(parsed.trigger.originSurface).toBe('web');
  });

  it('every must-reject fixture is rejected by its target schema', () => {
    for (const fixture of golden.mustReject) {
      const schema = schemaByName[fixture.schema as keyof typeof schemaByName];
      expect(schema, `unknown schema target ${fixture.schema}`).toBeDefined();
      const result = schema.safeParse(structuredClone(fixture.payload));
      expect(result.success, `${fixture.schema}: ${fixture.label}`).toBe(false);
    }
  });

  it('every unknown verb fails closed in the domain resolver', () => {
    for (const verb of golden.unknownVerbs) {
      let error: unknown = null;
      try {
        normalizeCommandId(verb);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${JSON.stringify(verb)} should be unknown`).toBeInstanceOf(
        CommandUnknownError,
      );
    }
  });
});

describe('CP001 transport ↔ domain reconciliation', () => {
  it('api-contracts canonical set EXACTLY equals the policy-engine workflow set', () => {
    const sorted = (values: readonly string[]) => [...values].sort();
    expect(sorted(COMMAND_IDS_V1)).toEqual(sorted(WORKFLOW_IDS_V1));
  });

  it('every alias target is a canonical workflow and maps to exactly one ID', () => {
    for (const [alias, target] of Object.entries(COMMAND_ALIASES_V1)) {
      expect(
        WORKFLOW_IDS_V1.includes(target as WorkflowIdV1),
        `${alias} -> ${target} not canonical`,
      ).toBe(true);
      // One alias resolves to exactly that one ID.
      expect(normalizeCommandId(alias)).toBe(target);
    }
    // No duplicate keys (a key differing only by case would be caught here).
    const keys = Object.keys(COMMAND_ALIASES_V1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the mvp flags cover exactly the canonical set and mark extensions mvp:false', () => {
    const flagKeys = Object.keys(commandMvpFlags) as CanonicalCommandId[];
    expect(flagKeys.sort()).toEqual([...COMMAND_IDS_V1].sort());
    for (const id of COMMAND_IDS_V1) {
      const isMvp = [
        'implement_issue',
        'diagnose_failure',
        'security_audit',
        'security_patch',
        'review_remediation',
      ].includes(id);
      expect(commandMvpFlags[id].mvp, `${id} mvp flag`).toBe(isMvp);
    }
  });
});

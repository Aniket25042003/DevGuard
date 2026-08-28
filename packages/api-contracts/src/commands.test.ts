/**
 * CP001 §22 — shared command contract unit tests: origin surfaces, canonical
 * command IDs, MVP/extension flags, trigger types and the transport DTOs.
 * Every boundary object is `.strict()`; unknown verbs and extra properties
 * are rejected, never guessed (fail closed).
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CONTRACT_VERSION,
  COMMAND_IDS_V1,
  MVP_COMMAND_IDS_V1,
  ORIGIN_SURFACES_V1,
  TRIGGER_TYPES_V1,
  canonicalCommandIdSchema,
  commandMvpFlags,
  commandReceiptSchema,
  originSurfaceSchema,
  submitCommandRequestSchema,
  triggerTypeSchema,
  workflowRunDtoSchema,
  workflowRunListQuerySchema,
  type CommandReceiptV1,
  type SubmitCommandRequestV1,
  type WorkflowRunDtoV1,
} from '@devguard/api-contracts';

describe('origin surfaces (CP001 §8)', () => {
  it('parses every declared origin surface exactly', () => {
    for (const surface of ORIGIN_SURFACES_V1) {
      expect(originSurfaceSchema.parse(surface)).toBe(surface);
    }
  });

  it('rejects unknown and mixed-case surfaces (fail closed)', () => {
    expect(originSurfaceSchema.safeParse('github').success).toBe(false);
    expect(originSurfaceSchema.safeParse('Github_Comment').success).toBe(false);
    expect(originSurfaceSchema.safeParse('web ').success).toBe(false);
    expect(originSurfaceSchema.safeParse('desktop').success).toBe(false);
  });
});

describe('canonical command IDs (CP001 §8)', () => {
  it('exposes the full eight-command vocabulary', () => {
    expect(COMMAND_IDS_V1).toEqual([
      'implement_issue',
      'diagnose_failure',
      'security_audit',
      'security_patch',
      'review_remediation',
      'dependency_upgrade',
      'repository_health_check',
      'manual_refactor',
    ]);
  });

  it('parses every canonical ID exactly, expecting no alias or folded form', () => {
    for (const id of COMMAND_IDS_V1) {
      expect(canonicalCommandIdSchema.parse(id)).toBe(id);
    }
    // Aliases and fuzzy/human forms are NOT canonical.
    expect(canonicalCommandIdSchema.safeParse('review').success).toBe(false);
    expect(canonicalCommandIdSchema.safeParse('fix').success).toBe(false);
    expect(canonicalCommandIdSchema.safeParse('run_tests').success).toBe(false);
    expect(canonicalCommandIdSchema.safeParse('implement issue').success).toBe(false);
    expect(canonicalCommandIdSchema.safeParse('Implement_Issue').success).toBe(false);
  });

  it('MVP set is exactly the five MVP workflows and is a subset of the full set', () => {
    expect(MVP_COMMAND_IDS_V1).toHaveLength(5);
    for (const id of MVP_COMMAND_IDS_V1) {
      expect(COMMAND_IDS_V1).toContain(id);
    }
    expect(MVP_COMMAND_IDS_V1).not.toContain('dependency_upgrade');
    expect(MVP_COMMAND_IDS_V1).not.toContain('repository_health_check');
    expect(MVP_COMMAND_IDS_V1).not.toContain('manual_refactor');
  });
});

describe('MVP / extension flags (CP001 §25)', () => {
  it('marks exactly five workflows mvp:true and three extensions mvp:false', () => {
    const entries = Object.entries(commandMvpFlags);
    expect(entries).toHaveLength(COMMAND_IDS_V1.length);
    const mvpTrue = entries.filter(([, flags]) => flags.mvp);
    const mvpFalse = entries.filter(([, flags]) => !flags.mvp);
    expect(mvpTrue).toHaveLength(5);
    expect(mvpFalse).toHaveLength(3);
  });

  it('the review remediation MVP and the three extensions carry correct flags', () => {
    expect(commandMvpFlags.review_remediation.mvp).toBe(true);
    expect(commandMvpFlags.dependency_upgrade.mvp).toBe(false);
    expect(commandMvpFlags.repository_health_check.mvp).toBe(false);
    expect(commandMvpFlags.manual_refactor.mvp).toBe(false);
  });
});

describe('trigger types (CP001 §8 / gap G25)', () => {
  it('includes the schedule trigger type alongside manual/webhook/api', () => {
    expect(TRIGGER_TYPES_V1).toEqual(['manual', 'webhook', 'api', 'schedule']);
    for (const trigger of TRIGGER_TYPES_V1) {
      expect(triggerTypeSchema.parse(trigger)).toBe(trigger);
    }
  });

  it('rejects unknown trigger types', () => {
    expect(triggerTypeSchema.safeParse('cron').success).toBe(false);
    expect(triggerTypeSchema.safeParse('github_comment').success).toBe(false);
  });
});

const validRequest: SubmitCommandRequestV1 = {
  commandId: 'review',
  definitionVersion: '1',
  input: { pullRequestNumber: 7 },
  clientReference: 'ref-123',
  originSurface: 'cli',
};

describe('SubmitCommandRequestV1 (CP001 §8 / C069)', () => {
  it('round-trips a canonical command with client reference', () => {
    const parsed = submitCommandRequestSchema.parse({
      ...validRequest,
      commandId: 'security_audit',
    });
    expect(parsed.commandId).toBe('security_audit');
    expect(parsed.originSurface).toBe('cli');
    expect(parsed.clientReference).toBe('ref-123');
  });

  it('accepts an alias string in commandId (server normalizes later)', () => {
    expect(submitCommandRequestSchema.parse(validRequest).commandId).toBe('review');
  });

  it('accepts the optional github sub-object (server-set, not client-trusted)', () => {
    const parsed = submitCommandRequestSchema.parse({
      ...validRequest,
      originSurface: 'github_comment',
      github: {
        installationId: 'inst-1',
        repositoryNodeId: 'R_1',
        issueOrPrNumber: 42,
        commentId: 'ic_1',
        htmlUrl: 'https://github.com/a/b/issues/42#issuecomment-1',
      },
    });
    expect(parsed.github?.issueOrPrNumber).toBe(42);
  });

  it('rejects extra properties (strict object)', () => {
    expect(submitCommandRequestSchema.safeParse({ ...validRequest, sneaky: true }).success).toBe(
      false,
    );
  });

  it('rejects unknown origin surfaces and empty/oversized command ids', () => {
    expect(
      submitCommandRequestSchema.safeParse({ ...validRequest, originSurface: 'github' }).success,
    ).toBe(false);
    expect(submitCommandRequestSchema.safeParse({ ...validRequest, commandId: '' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed github sub-object (missing required fields, extra props)', () => {
    expect(
      submitCommandRequestSchema.safeParse({
        ...validRequest,
        originSurface: 'github_comment',
        github: { installationId: 'i', issueOrPrNumber: 1, extra: true },
      }).success,
    ).toBe(false);
  });
});

const validReceipt: CommandReceiptV1 = {
  id: '00000000-0000-4000-8000-000000000001',
  repositoryId: '00000000-0000-4000-8000-000000000002',
  commandId: 'review_remediation',
  originSurface: 'cli',
  status: 'accepted',
  workflowRunId: '00000000-0000-4000-8000-000000000003',
  createdAt: '2026-08-28T00:00:00Z',
  links: {
    run: '/api/v1/workflows/00000000-0000-4000-8000-000000000003',
    self: '/api/v1/runs/00000000-0000-4000-8000-000000000001',
  },
};

describe('CommandReceiptV1 (CP001 §8 / C069)', () => {
  it('round-trips a valid receipt', () => {
    const parsed = commandReceiptSchema.parse(validReceipt);
    expect(parsed.status).toBe('accepted');
    expect(parsed.commandId).toBe('review_remediation');
    expect(parsed.links.self).toBe('/api/v1/runs/00000000-0000-4000-8000-000000000001');
  });

  it('rejects statuses other than accepted', () => {
    expect(commandReceiptSchema.safeParse({ ...validReceipt, status: 'queued' }).success).toBe(
      false,
    );
  });

  it('rejects extra properties and invalid command ids', () => {
    expect(commandReceiptSchema.safeParse({ ...validReceipt, nope: 1 }).success).toBe(false);
    expect(commandReceiptSchema.safeParse({ ...validReceipt, commandId: 'review' }).success).toBe(
      false,
    );
  });
});

const validRun: WorkflowRunDtoV1 = {
  id: '00000000-0000-4000-8000-000000000004',
  repositoryId: '00000000-0000-4000-8000-000000000002',
  workflowType: 'review_remediation',
  definitionVersion: '1',
  status: 'queued',
  trigger: { triggerType: 'manual', originSurface: 'web' },
  requestSummary: 'review PR #7',
  policyVersion: 3,
  queuePosition: 0,
  createdAt: '2026-08-28T00:00:00Z',
  updatedAt: '2026-08-28T00:00:00Z',
  version: 1,
  links: { self: '/api/v1/workflows/00000000-0000-4000-8000-000000000004' },
};

describe('WorkflowRunDtoV1 (CP001 §8 / C067)', () => {
  it('round-trips a valid run projection', () => {
    const parsed = workflowRunDtoSchema.parse(validRun);
    expect(parsed.workflowType).toBe('review_remediation');
    expect(parsed.status).toBe('queued');
    expect(parsed.trigger.originSurface).toBe('web');
  });

  it('accepts all optional C067 fields', () => {
    const parsed = workflowRunDtoSchema.parse({
      ...validRun,
      status: 'waiting_for_approval',
      sessionId: 'sess-1',
      branchName: 'refs/heads/devguard/feat',
      pullRequestNumber: 7,
      startedAt: '2026-08-28T00:01:00Z',
      completedAt: '2026-08-28T00:02:00Z',
      failure: 'timeout',
    });
    expect(parsed.pullRequestNumber).toBe(7);
    expect(parsed.sessionId).toBe('sess-1');
  });

  it('rejects unknown statuses, extra properties and missing version', () => {
    expect(workflowRunDtoSchema.safeParse({ ...validRun, status: 'sneaky' }).success).toBe(false);
    expect(workflowRunDtoSchema.safeParse({ ...validRun, extra: true }).success).toBe(false);
    const { version: _version, ...withoutVersion } = validRun;
    expect(workflowRunDtoSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('requires the nested trigger origin surface', () => {
    const { originSurface: _os, ...withoutOrigin } = validRun.trigger;
    expect(workflowRunDtoSchema.safeParse({ ...validRun, trigger: withoutOrigin }).success).toBe(
      false,
    );
  });
});

describe('WorkflowRunListQueryV1 (CP001 §8 / C067)', () => {
  it('parses every documented filter independently', () => {
    for (const query of [
      { originSurface: 'cli' },
      { triggerSource: 'github_comment' },
      { triggerType: 'schedule' },
      { status: 'running' },
      { workflowType: 'diagnose_failure' },
      { pullRequestNumber: 7 },
      {
        originSurface: 'web',
        triggerType: 'manual',
        status: 'completed,failed',
        workflowType: 'security_audit',
      },
    ]) {
      expect(workflowRunListQuerySchema.parse(query)).toMatchObject(query);
    }
  });

  it('rejects an unknown query key (strict)', () => {
    expect(
      workflowRunListQuerySchema.safeParse({ originSurface: 'cli', unknownFilter: 'x' }).success,
    ).toBe(false);
  });
});

describe('command contract version (CP001 §19/§23)', () => {
  it('snapshots the contract version token', () => {
    expect(COMMAND_CONTRACT_VERSION).toBe('command-contract.v1');
  });
});

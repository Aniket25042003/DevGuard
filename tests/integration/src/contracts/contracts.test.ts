import { describe, expect, it } from 'vitest';
import {
  actionProposal,
  ApprovalStatus,
  APPROVAL_TERMINAL_STATUSES,
  connectedRepository,
  DataClassification,
  eventEnvelopeBase,
  FindingSeverity,
  getRegisteredEvent,
  listRegisteredEventTypes,
  makeEvent,
  Obligation,
  parseEvent,
  PolicyEffect,
  publicApprovalView,
  publicWorkflowRunSummary,
  registerEvent,
  RiskClass,
  timestampIso,
  ValidationStatus,
  WorkflowStatus,
  WORKFLOW_TERMINAL_STATUSES,
  idSchemas,
  type EventEnvelopeShape,
} from '@devguard/contracts';

const NOW = '2026-08-25T12:00:00.000Z';

function baseEnvelope(): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    type: 'workflow.state.changed',
    aggregate: { type: 'workflow_run', id: idSchemas.workflowRunId.parse(crypto.randomUUID()) },
    occurredAt: NOW,
    correlation: { requestId: idSchemas.operationKey.parse(crypto.randomUUID()) },
    actor: { kind: 'agent' },
    payload: { from: 'running', to: 'waiting_for_approval' },
  };
}

describe('C004 canonical vocabularies are frozen', () => {
  it('freezes workflow statuses exactly per IF-1 (lowercase, incl. waiting/resuming)', () => {
    expect(WorkflowStatus.options).toEqual([
      'queued',
      'running',
      'waiting_for_approval',
      'resuming',
      'verifying',
      'completed',
      'failed',
      'cancelled',
      'rejected',
      'timed_out',
    ]);
    expect(WORKFLOW_TERMINAL_STATUSES).toEqual([
      'completed',
      'failed',
      'cancelled',
      'rejected',
      'timed_out',
    ]);
  });

  it('keeps exactly three authorization effects — sandbox is never an effect', () => {
    expect(PolicyEffect.options).toEqual(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
    const sandbox = Obligation.options[0];
    expect(sandbox.shape.kind.value).toBe('execution_environment');
  });

  it('covers all five risk classes and rejects unknown values', () => {
    expect(RiskClass.options).toEqual([
      'read',
      'reversible_write',
      'sensitive_write',
      'destructive',
      'external_side_effect',
    ]);
    expect(RiskClass.safeParse('magic_write').success).toBe(false);
  });

  it('rejects unknown approval/validation/severity values (fail closed)', () => {
    expect(ApprovalStatus.safeParse('maybe').success).toBe(false);
    expect(APPROVAL_TERMINAL_STATUSES).toContain('stale');
    expect(ValidationStatus.safeParse('passed_with_warnings').success).toBe(false);
    // Severity is explicit about unknown rather than guessing.
    expect(FindingSeverity.options).toContain('unknown');
    expect(DataClassification.options).toEqual(['public', 'internal', 'restricted']);
  });
});

describe('C004 primitives', () => {
  it('accepts UUID-shaped ids and rejects interchange between brands only at runtime shape level', () => {
    const runId = idSchemas.workflowRunId.parse(crypto.randomUUID());
    expect(typeof runId).toBe('string');
    expect(idSchemas.workflowRunId.safeParse('not-an-id').success).toBe(false);
    expect(idSchemas.workflowRunId.safeParse(crypto.randomUUID()).success).toBe(true);
  });

  it('validates ISO-8601 UTC timestamps strictly', () => {
    expect(timestampIso.safeParse('2026-08-25T12:00:00Z').success).toBe(true);
    expect(timestampIso.safeParse('2026-08-25T12:00:00.123456Z').success).toBe(true);
  });

  it('rejects date-only values and non-UTC offsets (Qodo fix)', () => {
    expect(timestampIso.safeParse('2026-08-25').success).toBe(false);
    expect(timestampIso.safeParse('2026-08-25T12:00:00+02:00').success).toBe(false);
    expect(timestampIso.safeParse('2026-08-25T14:00:00-0200').success).toBe(false);
    expect(timestampIso.safeParse('yesterday').success).toBe(false);
    expect(timestampIso.safeParse(123).success).toBe(false);
  });

  it('rejects malformed UUID-shaped identifiers (Qodo fix)', () => {
    const malformedIds = [
      'a-----------------------------------', // 36 chars of dashes after hex head
      'g18f6d2e-7c1a-7000-8000-000000000001', // non-hex leading char
      '018f6d2e7c1a70008000000000000 01', // whitespace
      'not-a-uuid',
      '', // too short
    ];
    for (const candidate of malformedIds) {
      expect(idSchemas.workflowRunId.safeParse(candidate).success, candidate).toBe(false);
    }
    // Valid shapes still accepted.
    expect(idSchemas.workflowRunId.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(idSchemas.workflowRunId.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true); // canonical ULID
  });
});

describe('C004 event envelope and registry', () => {
  it('round-trips makeEvent → parseEvent for every registered family', () => {
    const samples: Array<{ type: string; aggregateType: string; payload: unknown }> = [
      {
        type: 'configuration.validated',
        aggregateType: 'process',
        payload: { processKind: 'api', environment: 'test', configHash: 'abc' },
      },
      {
        type: 'feature_flag.changed',
        aggregateType: 'process',
        payload: { key: 'githubWritesEnabled', value: false },
      },
      {
        type: 'authorization.denied',
        aggregateType: 'repository',
        payload: {
          repositoryId: idSchemas.repositoryId.parse(crypto.randomUUID()),
          permission: 'approve',
          reasonCode: 'no_role',
        },
      },
      {
        type: 'repository.connected',
        aggregateType: 'repository',
        payload: { fullName: 'octo/repo', status: 'active' },
      },
      {
        type: 'workflow.queued',
        aggregateType: 'workflow_run',
        payload: {
          repositoryId: idSchemas.repositoryId.parse(crypto.randomUUID()),
          trigger: 'manual',
        },
      },
      {
        type: 'action.proposed',
        aggregateType: 'action',
        payload: { actionType: 'pull_request.merge', riskClass: 'sensitive_write' },
      },
      {
        type: 'policy.decision.recorded',
        aggregateType: 'policy_decision',
        payload: { effect: 'REQUIRE_APPROVAL', reasonCode: 'sensitive_write_requires_approval' },
      },
      { type: 'approval.required', aggregateType: 'approval', payload: {} },
      {
        type: 'validation.completed',
        aggregateType: 'validation_result',
        payload: { validator: 'unit_tests', commitSha: 'a'.repeat(40), status: 'passed' },
      },
      {
        type: 'artifact.created',
        aggregateType: 'artifact',
        payload: {
          classification: 'internal',
          checksumSha256: 'b'.repeat(64),
          contentType: 'text/plain',
        },
      },
      {
        type: 'webhook.accepted',
        aggregateType: 'webhook_delivery',
        payload: { deliveryExternalId: 'd-1', eventFamily: 'pull_request' },
      },
      {
        type: 'outbox.recorded',
        aggregateType: 'outbox_row',
        payload: { eventType: 'workflow.queued', destination: 'queue' },
      },
    ];
    for (const sample of samples) {
      expect(getRegisteredEvent(sample.type), sample.type).toBeDefined();
      const event = makeEvent({
        type: sample.type,
        aggregate: { type: sample.aggregateType, id: crypto.randomUUID() },
        occurredAt: NOW,
        actor: { kind: 'system' },
        sequence: 7,
        payload: sample.payload,
      });
      const parsed = parseEvent(JSON.parse(JSON.stringify(event)));
      expect(parsed.ok, `${sample.type}: ${JSON.stringify(parsed)}`).toBe(true);
      if (parsed.ok) {
        expect((parsed.value as EventEnvelopeShape).sequence).toBe(7);
      }
    }
  });

  it('rejects unknown action types inside action.proposed payloads (Qodo fix)', () => {
    const raw = baseEnvelope() as Record<string, unknown>;
    raw['type'] = 'action.proposed';
    raw['payload'] = { actionType: 'qodo.auto_merge_everything', riskClass: 'read' };
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid_payload');
  });

  it('public approval DTO rejects unknown action types (Qodo fix)', () => {
    const result = publicApprovalView.safeParse({
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      status: 'pending',
      repositoryFullName: 'octo/repo',
      actionType: 'qodo.auto_merge_everything',
      riskClass: 'read',
      rationaleSummary: 'x',
      expiresAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('fails closed on unknown event types without executing anything', () => {
    const raw = { ...baseEnvelope(), type: 'qodo.finding.created' };
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('unknown_type');
  });

  it('quarantines unknown schema versions with the distinct unknown_version reason', () => {
    const raw = { ...baseEnvelope(), schemaVersion: 99 };
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('unknown_version');
  });

  it('reports missing versions as unknown_version (never best-effort v1)', () => {
    const raw = baseEnvelope();
    delete raw['schemaVersion'];
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('unknown_version');
  });

  it('reports invalid payloads distinctly so producers can be migrated', () => {
    const raw = baseEnvelope();
    (raw['payload'] as Record<string, unknown>)['to'] = 'not_a_real_status';
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('invalid_payload');
  });

  it('strips additive unknown payload keys within schemaVersion 1 (forward compatible)', () => {
    const raw = baseEnvelope();
    (raw['payload'] as Record<string, unknown>)['futureAddition'] = { nested: true };
    const parsed = parseEvent(raw);
    expect(parsed.ok).toBe(true);
  });

  it('keeps registration unique and deterministic', () => {
    const before = listRegisteredEventTypes();
    expect(() =>
      registerEvent('configuration.validated', {
        family: 'configuration',
        description: 'duplicate',
        payload: eventEnvelopeBase,
      }),
    ).toThrowError(/already registered/);
    expect(listRegisteredEventTypes()).toEqual(before);
    expect(listRegisteredEventTypes()).toEqual([...before].sort());
  });
});

describe('C004 safe public projections', () => {
  it('reject over-posting on browser-facing DTOs (strict)', () => {
    const run = {
      id: crypto.randomUUID(),
      workflowKind: 'implement_issue',
      status: 'queued',
      repositoryId: crypto.randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
      fingerprintHex: 'attacker-controlled-extra',
    };
    expect(publicWorkflowRunSummary.safeParse(run).success).toBe(false);

    const approval = {
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      status: 'pending',
      repositoryFullName: 'octo/repo',
      actionType: 'pull_request.merge',
      riskClass: 'sensitive_write',
      rationaleSummary: 'merge after validation',
      expiresAt: NOW,
      storageRef: '../../etc/passwd',
    };
    expect(publicApprovalView.safeParse(approval).success).toBe(false);
  });

  it('external refs reject unknown keys and bad URLs', () => {
    const raw = baseEnvelope();
    raw['correlation'] = {};
    raw['actor'] = { kind: 'webhook_actor', login: 'x' }; // unknown key `login`
    const parsed = parseEvent(raw);
    // actorRef strips unknown keys (forward compatible), envelope remains valid.
    expect(parsed.ok).toBe(true);
  });
});

describe('C004 policy decisions bind approvals explicitly', () => {
  it('requires approvalType on REQUIRE_APPROVAL decisions', () => {
    const result = actionProposal.safeParse({
      actionType: 'pull_request.merge',
      riskClass: 'sensitive_write',
      actorKind: 'agent',
      proposedAt: NOW,
      targetRef: { headSha: 'a'.repeat(40) },
    });
    expect(result.success).toBe(true);
    void result;
  });

  it('validates sha targets when provided', () => {
    const short = actionProposal.safeParse({
      actionType: 'commit.push',
      riskClass: 'reversible_write',
      actorKind: 'agent',
      proposedAt: NOW,
      targetRef: { headSha: 'abc123' },
    });
    expect(short.success).toBe(false);
  });

  it('parses a fully connected repository projection with provenance', () => {
    const parsed = connectedRepository.safeParse({
      id: crypto.randomUUID(),
      installationRef: 'inst-1',
      owner: 'octo',
      name: 'repo',
      fullName: 'octo/repo',
      status: 'active',
      externalRef: {
        provider: 'github',
        type: 'repository',
        id: '1234',
        url: 'https://api.github.com/repos/octo/repo',
      },
      metadataProvenance: {
        source: 'github',
        capturedAt: NOW,
        externalRef: { provider: 'github', type: 'repository', id: '1234' },
      },
      createdAt: NOW,
      updatedAt: NOW,
      rowVersion: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('enforces fullName consistency', () => {
    const bad = connectedRepository.safeParse({
      id: crypto.randomUUID(),
      installationRef: 'inst-1',
      owner: 'octo',
      name: 'repo',
      fullName: 'other/name',
      status: 'active',
      externalRef: { provider: 'github', type: 'repository', id: '1234' },
      createdAt: NOW,
      updatedAt: NOW,
      rowVersion: 1,
    });
    expect(bad.success).toBe(false);
  });
});

describe('C004 Qodo round-2 hardening', () => {
  const NOW = '2026-08-25T12:00:00.000Z';

  it('rejects spoofed risk classes on action proposals and tool bindings', async () => {
    const { actionProposal, riskClassForAction, toolBinding } = await import('@devguard/contracts');
    expect(riskClassForAction('pull_request.merge')).toBe('sensitive_write');

    const spoof = actionProposal.safeParse({
      actionType: 'pull_request.merge',
      riskClass: 'read',
      actorKind: 'agent',
      proposedAt: NOW,
    });
    expect(spoof.success).toBe(false);

    const honest = actionProposal.safeParse({
      actionType: 'pull_request.merge',
      riskClass: 'sensitive_write',
      actorKind: 'agent',
      proposedAt: NOW,
    });
    expect(honest.success).toBe(true);

    const bindingSpoof = toolBinding.safeParse({
      toolName: 'github_merge',
      provider: 'github_adapter',
      actionType: 'pull_request.merge',
      riskClass: 'read',
      enabled: true,
    });
    expect(bindingSpoof.success).toBe(false);
  });

  it('requires exact target fields for sensitive/destructive approvals', async () => {
    const { approvalFingerprintInput } = await import('@devguard/contracts');
    const baseTarget = {
      installationRef: 'inst-1',
      repositoryFullName: 'octo/repo',
      policyVersionRef: 'pv-1',
      validationSnapshotDigest: 'c'.repeat(64),
    };

    const unboundMerge = approvalFingerprintInput.safeParse({
      ...baseTarget,
      actionType: 'pull_request.merge',
      riskClass: 'sensitive_write',
    });
    expect(unboundMerge.success).toBe(false);
    if (!unboundMerge.success) {
      const paths = unboundMerge.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('pullRequestNumber');
      expect(paths).toContain('headSha');
    }

    const boundMerge = approvalFingerprintInput.safeParse({
      ...baseTarget,
      actionType: 'pull_request.merge',
      riskClass: 'sensitive_write',
      pullRequestNumber: 42,
      headSha: 'a'.repeat(40),
    });
    expect(boundMerge.success).toBe(true);

    const unboundPush = approvalFingerprintInput.safeParse({
      ...baseTarget,
      actionType: 'commit.push',
      riskClass: 'reversible_write',
    });
    expect(unboundPush.success).toBe(false);
  });

  it('makeEvent validates aggregate/sequence/correlation against the envelope schemas', async () => {
    const { makeEvent } = await import('@devguard/contracts');
    const base = {
      type: 'workflow.state.changed',
      occurredAt: NOW,
      actor: { kind: 'system' as const },
      payload: { from: 'queued' as const, to: 'running' as const },
    };
    expect(() =>
      makeEvent({ ...base, aggregate: { type: '', id: 'x' }, payload: base.payload }),
    ).toThrowError(/Invalid event envelope/);
    expect(() =>
      makeEvent({
        ...base,
        aggregate: { type: 'workflow_run', id: crypto.randomUUID() },
        sequence: -5,
        payload: base.payload,
      }),
    ).toThrowError(/Invalid event envelope/);
  });

  it('enforces single canonical ID casing', async () => {
    const { idSchemas } = await import('@devguard/contracts');
    expect(idSchemas.workflowRunId.safeParse(crypto.randomUUID().toUpperCase()).success).toBe(
      false,
    );
    expect(idSchemas.workflowRunId.safeParse('01arz3ndektsv4rrffq69g5fav').success).toBe(false); // lowercase ULID
    expect(idSchemas.workflowRunId.safeParse(crypto.randomUUID()).success).toBe(true); // lowercase UUID
    expect(idSchemas.workflowRunId.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true); // uppercase ULID
  });

  it('public DTOs use canonical enums and strict UTC timestamps', async () => {
    const { publicWorkflowRunSummary } = await import('@devguard/contracts');
    const base = {
      id: crypto.randomUUID(),
      status: 'queued',
      repositoryId: crypto.randomUUID(),
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      publicWorkflowRunSummary.safeParse({ ...base, workflowKind: 'implement_issue' }).success,
    ).toBe(true);
    expect(
      publicWorkflowRunSummary.safeParse({ ...base, workflowKind: 'dependency_upgrade' }).success,
    ).toBe(false);
    expect(
      publicWorkflowRunSummary.safeParse({
        ...base,
        workflowKind: 'implement_issue',
        createdAt: '2026-08-25',
      }).success,
    ).toBe(false);
  });

  it('narrows entity-specific external references', async () => {
    const { connectedRepository, workflowCompletion, validationResult } =
      await import('@devguard/contracts');
    void validationResult;
    const repoBad = connectedRepository.safeParse({
      id: crypto.randomUUID(),
      installationRef: 'inst',
      owner: 'octo',
      name: 'repo',
      fullName: 'octo/repo',
      status: 'active',
      externalRef: { provider: 'github', type: 'issue', id: '7' },
      createdAt: NOW,
      updatedAt: NOW,
      rowVersion: 1,
    });
    expect(repoBad.success).toBe(false);

    const prBad = workflowCompletion.safeParse({
      status: 'success',
      summary: 'done',
      artifactIds: [],
      validations: [],
      pullRequest: { provider: 'github', type: 'repository', id: '9' },
    });
    expect(prBad.success).toBe(false);

    const prGood = workflowCompletion.safeParse({
      status: 'success',
      summary: 'done',
      artifactIds: [],
      validations: [],
      pullRequest: { provider: 'github', type: 'pull_request', id: '9' },
    });
    expect(prGood.success).toBe(true);
  });
});

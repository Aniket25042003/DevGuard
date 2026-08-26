/**
 * C092 — AgentTrustService: registration, trust evaluation, context assembly,
 * and model-proposal validation.
 *
 * Authority context is built from SERVER-OWNED inputs (global rules digest,
 * immutable policy snapshot digest, workflow definition digest). Content is
 * accepted only through provenance-aware methods. Model-supplied
 * authorization fields are stripped and the proposal is reconstructed from
 * trusted workflow state before it can become a typed C039 proposal.
 */
import {
  actionProposal,
  makeEvent,
  riskClassForAction,
  type ActionType,
} from '@devguard/contracts';
import { makeError } from '@devguard/errors';
import { encodeUntrustedSection, openBoundary, closeBoundary } from './boundary.js';
import type { ProvenanceEnvelopeShape } from './provenance.js';
import { registerSource, sha256Hex, TRUST_RANK } from './provenance.js';
import { resolveInstructionConflicts } from './precedence.js';

export type TrustDecision = 'include' | 'include_as_data' | 'exclude' | 'quarantine' | 'block';

export interface TrustEvaluationShape {
  readonly envelopeId: string;
  readonly decision: TrustDecision;
  readonly reasonCodes: readonly string[];
  readonly signalRuleIds: readonly string[];
  readonly evaluatedAt: string;
  readonly authoritySnapshotDigest: string;
}

/** Server-owned authority anchors for one evaluation/bundle scope. */
export interface AuthorityContext {
  readonly globalSafetyDigest: string;
  readonly repositoryPolicyDigest: string;
  readonly workflowDefinitionDigest: string;
}

export function authoritySnapshotDigest(authority: AuthorityContext): string {
  return sha256Hex(
    `${authority.globalSafetyDigest}:${authority.repositoryPolicyDigest}:${authority.workflowDefinitionDigest}`,
  );
}

type ItemStage =
  'RECEIVED' | 'VALIDATED' | 'CLASSIFIED' | 'INCLUDED' | 'EXCLUDED' | 'QUARANTINED' | 'BLOCKED';

const LEGAL_TRANSITIONS: Readonly<Record<ItemStage, readonly ItemStage[]>> = Object.freeze({
  RECEIVED: ['VALIDATED'],
  VALIDATED: ['CLASSIFIED'],
  CLASSIFIED: ['INCLUDED', 'EXCLUDED', 'QUARANTINED', 'BLOCKED'],
  INCLUDED: [],
  EXCLUDED: [],
  QUARANTINED: [],
  BLOCKED: [],
});

interface TrackedItem {
  readonly envelope: ProvenanceEnvelopeShape;
  stage: ItemStage;
}

export interface EventSink {
  (event: ReturnType<typeof makeEvent>): void;
}

export interface AssembledSection {
  readonly label: string;
  readonly trustClass: string;
  readonly provenanceIds: readonly string[];
  readonly text: string;
  readonly encodedDigest: string;
}

export interface TrustedContextBundleShape {
  readonly bundleDigest: string;
  readonly authorityDigest: string;
  readonly sections: readonly AssembledSection[];
  readonly rejectedInstructionIds: readonly string[];
  readonly quarantinedIds: readonly string[];
  readonly createdAt: string;
}

const SECTION_LABELS: ReadonlyArray<{
  readonly classes: readonly string[];
  readonly label: string;
}> = [
  { classes: ['control_plane'], label: 'DEVGUARD_CONTROL' },
  { classes: ['authenticated_request'], label: 'TASK_REQUEST' },
  { classes: ['advisory_instruction'], label: 'ADVISORY_INSTRUCTIONS' },
  { classes: ['untrusted_data'], label: 'UNTRUSTED_DATA' },
];

export class AgentTrustService {
  private readonly items = new Map<string, TrackedItem>();
  private readonly evaluations = new Map<string, TrustEvaluationShape>();

  constructor(
    private readonly authority: () => AuthorityContext,
    private readonly now: () => Date = () => new Date(),
    private readonly onEvent?: EventSink | undefined,
  ) {}

  /** Register content with provenance; fails closed per registerSource rules. */
  registerSource(input: Parameters<typeof registerSource>[0]): ProvenanceEnvelopeShape {
    const envelope = registerSource(input, { now: this.now });
    this.items.set(envelope.id, { envelope, stage: 'RECEIVED' });
    this.emit('context.provenance.recorded', {
      provenanceId: envelope.id,
      sourceKind: envelope.sourceKind,
      trustClass: envelope.trustClass,
      contentDigest: envelope.digest,
    });
    return envelope;
  }

  /**
   * Evaluate one registered item against current authority. Decisions:
   * - control-plane sources → include (they ARE the controls)
   * - advisory/authenticated/untrusted → include_as_data after conflict scan
   * - injection signals or conflicts → quarantine (evidence retained)
   */
  async evaluateTrust(envelopeId: string): Promise<TrustEvaluationShape> {
    const item = this.requireItem(envelopeId);
    const authority = this.authority();
    const snapshotDigest = authoritySnapshotDigest(authority);

    if (!this.transition(item, 'VALIDATED') || !this.transition(item, 'CLASSIFIED')) {
      throw makeError('TRUST_ITEM_INVALID_TRANSITION', {
        details: { from: item.stage, to: 'CLASSIFIED' },
        cause: new Error('state'),
      });
    }

    if (!this.sealedIds.has(envelopeId)) {
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'content' },
        cause: new Error('evaluate requires sealed content'),
      });
    }
    const text = this.contentOf(item.envelope);
    const resolution = resolveInstructionConflicts([{ envelope: item.envelope, text }]);
    const signals = resolution.signals[item.envelope.id] ?? [];

    let decision: TrustDecision;
    const reasons: string[] = [];

    if (resolution.rejected.length > 0) {
      decision = 'quarantine';
      for (const rejection of resolution.rejected) {
        reasons.push(rejection.reasonCode);
        this.emit('instruction.rejected', {
          ...(item.envelope.path !== undefined ? { path: item.envelope.path } : {}),
          reasonCode: rejection.reasonCode,
        });
        this.emit('security.trust_violation', {
          sourceKind: item.envelope.sourceKind,
          reasonCode: rejection.reasonCode,
        });
      }
    } else if (signals.length > 0) {
      decision = 'quarantine';
      reasons.push('injection_signals_present');
      this.emit('security.untrusted_content.quarantined', {
        contentDigest: item.envelope.digest,
        reasonCode: 'injection_signals_present',
      });
      this.emit('security.trust_violation', {
        sourceKind: item.envelope.sourceKind,
        reasonCode: 'injection_signals_present',
      });
    } else if (TRUST_RANK[item.envelope.sourceKind] === 'control_plane') {
      decision = 'include';
      reasons.push('control_plane_source');
    } else {
      decision = 'include_as_data';
      reasons.push('quoted_untrusted_data');
    }

    const evaluation: TrustEvaluationShape = {
      envelopeId,
      decision,
      reasonCodes: reasons,
      signalRuleIds: signals.map((signal) => signal.ruleId),
      evaluatedAt: this.now().toISOString(),
      authoritySnapshotDigest: snapshotDigest,
    };
    this.evaluations.set(envelopeId, evaluation);

    if (decision === 'include' || decision === 'include_as_data') {
      this.transition(item, 'INCLUDED');
    } else if (decision === 'quarantine') {
      this.transition(item, 'QUARANTINED');
    } else if (decision === 'block') {
      this.transition(item, 'BLOCKED');
    } else {
      this.transition(item, 'EXCLUDED');
    }
    return evaluation;
  }

  /**
   * Assemble an immutable labeled bundle from evaluated items. Untrusted
   * sections are quoted between boundaries carrying their provenance.
   */
  assembleContext(envelopeIds: readonly string[]): TrustedContextBundleShape {
    const authority = this.authority();
    const sections: AssembledSection[] = [];
    const quarantined: string[] = [];
    const rejected: string[] = [];

    for (const label of SECTION_LABELS) {
      const parts: string[] = [];
      const ids: string[] = [];
      for (const id of envelopeIds) {
        const item = this.items.get(id);
        if (item === undefined) continue;
        const evaluation = this.evaluations.get(id);
        if (evaluation?.decision === 'quarantine' || evaluation?.decision === 'block') {
          quarantined.push(id);
          if (evaluation.reasonCodes.some((r) => r.startsWith('instruction_'))) {
            rejected.push(id);
          }
          continue;
        }
        if (!label.classes.includes(TRUST_RANK[item.envelope.sourceKind])) continue;
        if (
          evaluation === undefined ||
          evaluation.authoritySnapshotDigest !== authoritySnapshotDigest(authority)
        )
          continue;

        if (label.classes[0] === 'untrusted_data') {
          const encoded = encodeUntrustedSection(item.envelope, this.contentOf(item.envelope));
          parts.push(encoded.text);
          ids.push(id);
        } else {
          parts.push(this.contentOf(item.envelope));
          ids.push(id);
        }
      }
      if (parts.length > 0) {
        const text = parts.join('\n\n');
        sections.push({
          label: label.label,
          trustClass: label.classes.join('+'),
          provenanceIds: ids,
          text,
          encodedDigest: sha256Hex(text),
        });
      }
      void openBoundary;
      void closeBoundary;
    }

    const bundleDigest = sha256Hex(sections.map((section) => section.encodedDigest).join('|'));
    return {
      bundleDigest,
      authorityDigest: authoritySnapshotDigest(authority),
      sections,
      rejectedInstructionIds: [...new Set(rejected)],
      quarantinedIds: [...new Set(quarantined)],
      createdAt: this.now().toISOString(),
    };
  }

  /**
   * Strip ALL model-supplied authorization/control fields from a proposal and
   * re-derive identity from trusted workflow state. What remains is a typed
   * proposal body that still must traverse C039/C024/C030 authorization.
   */
  validateModelProposal(
    rawProposal: Record<string, unknown>,
    trustedWorkflowState: {
      readonly runId: string;
      readonly workflowId: string;
      readonly policyVersionRef: string;
      readonly repositoryId: string;
    },
  ): ValidatedActionProposal {
    const strippedFields: string[] = [];
    const cleaned: Record<string, unknown> = {};
    const FORBIDDEN_FIELDS = [
      'policyVersionId',
      'policyVersionRef',
      'approvalId',
      'decision',
      'effect',
      'authorizedActions',
      'allowedActions',
      'riskOverride',
      'scopeOverride',
      'repositoryIdOverride',
    ] as const;
    for (const [key, value] of Object.entries(rawProposal)) {
      if ((FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
        strippedFields.push(key);
        continue;
      }
      cleaned[key] = value;
    }
    if (strippedFields.length > 0) {
      this.emit('security.trust_violation', {
        sourceKind: 'model_output',
        reasonCode: 'authorization_fields_stripped',
      });
    }
    // Action/target must survive cleaning, else nothing trustworthy to propose.
    if (
      typeof cleaned['actionType'] !== 'string' ||
      Array.isArray(cleaned['targetRef']) ||
      typeof cleaned['targetRef'] !== 'object' ||
      cleaned['targetRef'] === null
    ) {
      throw makeError('UNTRUSTED_PROPOSAL_REJECTED', {
        details: { strippedFields },
        cause: new Error('missing/invalid actionType or targetRef after stripping'),
      });
    }

    // Canonical validation: closed action taxonomy + derived risk + target shape.
    const candidate = actionProposal.safeParse({
      actionType: cleaned['actionType'],
      riskClass: riskClassForAction(cleaned['actionType'] as ActionType),
      actorKind: 'agent',
      targetRef: cleaned['targetRef'],
      proposedAt: this.now().toISOString(),
    });
    if (!candidate.success) {
      throw makeError('UNTRUSTED_PROPOSAL_REJECTED', {
        details: { strippedFields },
        cause: new Error(`canonical validation failed: ${candidate.error.issues.length} issue(s)`),
      });
    }

    return {
      actionType: candidate.data.actionType,
      targetRef: candidate.data.targetRef ?? {},
      justificationSummary:
        typeof cleaned['justificationSummary'] === 'string'
          ? (cleaned['justificationSummary'] as string).slice(0, 2000)
          : '',
      // Trusted reconstruction from durable state — never from the proposal.
      workflowRunId: trustedWorkflowState.runId,
      workflowId: trustedWorkflowState.workflowId,
      policyVersionRef: trustedWorkflowState.policyVersionRef,
      repositoryId: trustedWorkflowState.repositoryId,
      strippedFields,
      proposalDigest: sha256Hex(JSON.stringify({ cleaned, trustedWorkflowState })),
    };
  }

  /** Control fields may originate ONLY from control-plane/authenticated envelopes. */
  assertTrustedControlField(fieldOwnerEnvelopeId: string): void {
    const item = this.requireItem(fieldOwnerEnvelopeId);
    if (
      TRUST_RANK[item.envelope.sourceKind] !== 'control_plane' &&
      item.envelope.sourceKind !== 'task_request'
    ) {
      throw makeError('UNTRUSTED_PROPOSAL_REJECTED', {
        details: { strippedFields: [fieldOwnerEnvelopeId] },
        cause: new Error(`source kind ${item.envelope.sourceKind} cannot own control fields`),
      });
    }
  }

  evaluationOf(envelopeId: string): TrustEvaluationShape | undefined {
    return this.evaluations.get(envelopeId);
  }

  private requireItem(id: string): TrackedItem {
    const item = this.items.get(id);
    if (item === undefined) {
      // Unknown/missing provenance fails closed.
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'id' },
        cause: new Error(`unknown ${id}`),
      });
    }
    return item;
  }

  private transition(item: TrackedItem, to: ItemStage): boolean {
    const allowed = LEGAL_TRANSITIONS[item.stage];
    if (!allowed.includes(to)) {
      throw makeError('TRUST_ITEM_INVALID_TRANSITION', {
        details: { from: item.stage, to },
        cause: new Error('illegal transition'),
      });
    }
    item.stage = to;
    return true;
  }

  private emit(
    type:
      | 'security.trust_violation'
      | 'security.untrusted_content.quarantined'
      | 'context.provenance.recorded'
      | 'instruction.rejected',
    payload: Record<string, unknown>,
  ): void {
    if (this.onEvent === undefined) return;
    this.onEvent(
      makeEvent({
        type,
        aggregate: {
          type: 'trust_item',
          id:
            (payload['provenanceId'] as string) ??
            (payload['contentDigest'] as string) ??
            crypto.randomUUID(),
        },
        occurredAt: this.now().toISOString(),
        actor: { kind: 'system' },
        payload,
      }),
    );
  }

  /** Content is bound ONCE, verified against the envelope digest, then sealed. */
  private contents = new Map<string, string>();
  private sealedIds = new Set<string>();

  attachContent(envelopeId: string, content: string): void {
    const item = this.items.get(envelopeId);
    if (item === undefined) {
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'id' },
        cause: new Error(`unknown ${envelopeId}`),
      });
    }
    if (this.sealedIds.has(envelopeId)) {
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'content' },
        cause: new Error('content already sealed'),
      });
    }
    if (this.evaluations.has(envelopeId)) {
      // Unscanned bytes must never enter context after evaluation.
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'content' },
        cause: new Error('content changed after evaluation'),
      });
    }
    if (sha256Hex(content) !== item.envelope.digest) {
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'content' },
        cause: new Error('digest mismatch on attach'),
      });
    }
    this.contents.set(envelopeId, Object.freeze(content) as string);
    this.sealedIds.add(envelopeId);
  }

  private contentOf(envelope: ProvenanceEnvelopeShape): string {
    const stored = this.contents.get(envelope.id);
    if (stored === undefined) {
      throw makeError('PROVENANCE_INVALID', {
        details: { field: 'content' },
        cause: new Error(`no sealed content for ${envelope.id}`),
      });
    }
    return stored;
  }

  /** Convenience: register + attach (digest-verified) in one call. */
  registerWithContent(
    input: Parameters<typeof registerSource>[0],
    content: string,
  ): ProvenanceEnvelopeShape {
    const envelope = this.registerSource({ ...input, content });
    this.attachContent(envelope.id, content);
    return envelope;
  }
}

export interface ValidatedActionProposal {
  readonly actionType: ActionType;
  readonly targetRef: Record<string, unknown>;
  readonly justificationSummary: string;
  readonly workflowRunId: string;
  readonly workflowId: string;
  readonly policyVersionRef: string;
  readonly repositoryId: string;
  readonly strippedFields: readonly string[];
  readonly proposalDigest: string;
}

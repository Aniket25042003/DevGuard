/**
 * C092 — Immutable instruction precedence and conflict resolution.
 *
 * Non-overridable order (PRD §42.2):
 *   global_safety > repository_policy > workflow_rule >
 *   advisory instructions (AGENTS.md/CONTRIBUTING.md) >
 *   authenticated task request > all other content (data only).
 *
 * Lower-authority items that attempt to exercise higher-authority power are
 * REJECTED with reasons — they are never merged, truncated, or softened.
 */
import type { ProvenanceEnvelopeShape, SourceKind } from './provenance.js';
import { TRUST_RANK } from './provenance.js';
import { detectInjectionSignals, type InjectionSignal } from './scanner.js';

const AUTHORITY: Readonly<Record<SourceKind, number>> = Object.freeze({
  global_safety: 0,
  repository_policy: 1,
  workflow_rule: 2,
  agents_md: 3,
  contributing: 3,
  task_request: 4,
  readme: 5,
  issue: 5,
  pr_body: 5,
  review: 5,
  comment: 5,
  source: 5,
  test: 5,
  generated: 5,
  dependency: 5,
  tool_output: 5,
  provider_output: 5,
  model_output: 5,
  subagent_output: 5,
});

export function authorityOf(kind: SourceKind): number {
  return AUTHORITY[kind];
}

export interface InstructionItem {
  readonly envelope: ProvenanceEnvelopeShape;
  readonly text: string;
}

export interface RejectedInstruction {
  readonly item: InstructionItem;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface InstructionResolution {
  readonly accepted: readonly InstructionItem[];
  readonly rejected: readonly RejectedInstruction[];
}

/**
 * Deterministic control-directive patterns. A match in an item whose
 * authority is below the targeted domain is a CONFLICT, not advice.
 */
const CONTROL_DIRECTIVES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly targetsAuthorityAbove: SourceKind;
  readonly reasonCode: string;
}> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|earlier)\s+(instructions|rules|policies)/i,
    targetsAuthorityAbove: 'global_safety',
    reasonCode: 'override_attempt',
  },
  {
    pattern: /disregard\s+(all\s+)?(policy|policies|safety|guardrails)/i,
    targetsAuthorityAbove: 'repository_policy',
    reasonCode: 'override_attempt',
  },
  {
    pattern: /you\s+are\s+now\s+(a|an|the)\s+/i,
    targetsAuthorityAbove: 'global_safety',
    reasonCode: 'role_hijack',
  },
  { pattern: /system\s*:\s*/i, targetsAuthorityAbove: 'global_safety', reasonCode: 'role_hijack' },
  {
    pattern: /<\|im_start\|>|<\|endoftext\|>/i,
    targetsAuthorityAbove: 'global_safety',
    reasonCode: 'chat_markup',
  },
  {
    pattern: /\b(approve|accept)\s+(this|the)\s+(action|operation|pull request|merge)\b/i,
    targetsAuthorityAbove: 'workflow_rule',
    reasonCode: 'approval_grant_claim',
  },
  {
    pattern: /\b(i|we)\s+(hereby\s+)?approve\b/i,
    targetsAuthorityAbove: 'workflow_rule',
    reasonCode: 'approval_grant_claim',
  },
  {
    pattern: /\bgrant(ed)?\s+(access|permission|capability)\b/i,
    targetsAuthorityAbove: 'repository_policy',
    reasonCode: 'capability_grant_claim',
  },
  {
    pattern:
      /\b(reveal|print|show|output)\s+(the\s+)?(api[_ ]?key|secret|password|token|credentials)\b/i,
    targetsAuthorityAbove: 'global_safety',
    reasonCode: 'secret_exfil_attempt',
  },
  {
    pattern: /\bpolicy\s+version\s+(is\s+now|updated\s+to)\b/i,
    targetsAuthorityAbove: 'repository_policy',
    reasonCode: 'policy_mutation_claim',
  },
];

/**
 * Resolve instruction conflicts for a context bundle.
 *
 * Rules:
 * 1. Any item whose text matches a control directive targeting an authority
 *    domain ABOVE its own rank is rejected (reason + both digests recorded).
 * 2. Advisory instructions never mutate control-plane items; the control item
 *    always wins and the advisory rejection is reported.
 * 3. Deterministic injection SIGNALS are attached as evidence but cannot
 *    authorize or de-authorize anything by themselves.
 */
export function resolveInstructionConflicts(
  items: readonly InstructionItem[],
): InstructionResolution & {
  readonly signals: Readonly<Record<string, readonly InjectionSignal[]>>;
} {
  const accepted: InstructionItem[] = [];
  const rejected: RejectedInstruction[] = [];
  const signals: Record<string, InjectionSignal[]> = {};

  for (const item of items) {
    const itemRank = AUTHORITY[item.envelope.sourceKind];
    const found = detectInjectionSignals(item.text);
    if (found.length > 0) signals[item.envelope.id] = found;

    let conflict: RejectedInstruction | undefined;
    for (const directive of CONTROL_DIRECTIVES) {
      if (!directive.pattern.test(item.text)) continue;
      const targetRank = AUTHORITY[directive.targetsAuthorityAbove];
      if (targetRank < itemRank) {
        conflict = {
          item,
          reasonCode: `instruction_${directive.reasonCode}`,
          detail: `${item.envelope.sourceKind} attempted to influence ${directive.targetsAuthorityAbove} controls`,
        };
        break;
      }
    }
    if (conflict !== undefined) {
      rejected.push(conflict);
      continue;
    }
    accepted.push(item);
  }

  // Enforce strict ordering knowledge: nothing here mutates inputs; callers
  // assemble sections by explicit trust class afterwards.
  void TRUST_RANK;
  return { accepted, rejected, signals };
}

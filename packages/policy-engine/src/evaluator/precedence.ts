/**
 * C030 §12 — the exact precedence model, encoded stage-by-stage.
 *
 * Stages (short-circuiting in this order):
 *  1. Global deny
 *  2. Repository deny
 *  3. Unknown fail-closed
 *  4. Workflow permission
 *  5. Hard autonomy/safety ceiling (deny part; floors contribute)
 *  6. Contextual escalation (may only add restrictions/obligations)
 *  7. Explicit approval — satisfies eligible approval requirements ONLY;
 *     never overrides deny/unknown/workflow/hard-ceiling results
 *  8. Explicit allow
 *  9. Risk default
 * 10. No rule → DENY
 *
 * Obligations compose separately from effects and can never weaken one.
 */
import type { AutonomyLevel, ExecutionEnvironment, Obligation } from '@devguard/contracts';

export type DecisionEffect = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type RiskClass5 =
  'read' | 'reversible_write' | 'sensitive_write' | 'destructive' | 'external_side_effect';

export const EVALUATOR_VERSION = 'policy-evaluator@1';

export interface MatchedRule {
  readonly stage: number;
  readonly ruleId: string;
  readonly effect: DecisionEffect;
  readonly explanation: string;
}

/** Complete typed input; unknown dimensions arrive pre-resolved as undefined. */
export interface EvaluationInput {
  readonly actionId: string | undefined; // undefined => unknown capability
  readonly riskClass: RiskClass5 | undefined;
  readonly repositoryDenyMatch: boolean | undefined;
  readonly globalDenyMatch: boolean | undefined;
  readonly globalApprovalFloorMatch: boolean | undefined;
  readonly workflowPermitted: boolean | undefined;
  readonly ceilingEffect: DecisionEffect | undefined; // from C027 autonomyRestrictions strongest
  readonly contextRequiresApproval: boolean | undefined; // C025/C026 escalations
  readonly sandboxRequired: boolean | undefined;
  readonly gateSatisfied: boolean | undefined; // C029 outcome present & SATISFIED for gated actions
  readonly gateRequired: boolean;
  readonly explicitAllowMatch: boolean;
  readonly explicitRequireApprovalMatch: boolean;
  readonly explicitDenyMatch: boolean;
  /** Exact, fresh, authorized approval evidence bound to THIS operation. */
  readonly exactValidApprovalPresent: boolean;
  readonly targetsProtectedBranch?: boolean | undefined;
  readonly mergesProtectedBranch?: boolean | undefined;
}

export interface EvaluationOutcome {
  readonly effect: DecisionEffect;
  readonly reasonCode: string;
  readonly matchedRules: readonly MatchedRule[];
  readonly obligations: readonly Obligation[];
  readonly explanation: string;
}

function strongest(a: DecisionEffect | undefined, b: DecisionEffect): DecisionEffect {
  if (!a) return b;
  if (a === 'DENY' || b === 'DENY') return 'DENY';
  if (a === 'REQUIRE_APPROVAL' || b === 'REQUIRE_APPROVAL') return 'REQUIRE_APPROVAL';
  return 'ALLOW';
}

function rule(stage: number, id: string, effect: DecisionEffect, explanation: string): MatchedRule {
  return { stage, ruleId: id, effect, explanation };
}

/**
 * Pure precedence evaluation. Deterministic for fixed input; no clock, no IO.
 */
export function evaluatePrecedence(input: EvaluationInput): EvaluationOutcome {
  const rules: MatchedRule[] = [];
  let effect: DecisionEffect | undefined;
  let obligations: Obligation[] = [];

  // Stage 1 — global deny is absolute.
  if (input.globalDenyMatch) {
    rules.push(
      rule(
        1,
        'stage1-global-deny',
        'DENY',
        'a non-overridable global safety denial matches this action',
      ),
    );
    return finalize(
      'DENY',
      'GLOBAL_SAFETY_DENY',
      rules,
      obligations,
      'global safety denies this operation regardless of policy or approvals',
    );
  }

  // Stage 2 — repository deny is absolute.
  if (input.repositoryDenyMatch) {
    rules.push(
      rule(
        2,
        'stage2-repository-deny',
        'DENY',
        'the active canonical repository policy denies this action',
      ),
    );
    return finalize(
      'DENY',
      'REPOSITORY_DENIED',
      rules,
      obligations,
      'repository policy denies this action',
    );
  }

  // Stage 3 — unknown fail-closed across every dimension.
  const unknownDimensions: string[] = [];
  if (!input.actionId) unknownDimensions.push('action');
  if (!input.riskClass) unknownDimensions.push('risk classification');
  if (
    input.globalDenyMatch === undefined ||
    input.repositoryDenyMatch === undefined ||
    input.workflowPermitted === undefined ||
    input.ceilingEffect === undefined ||
    input.contextRequiresApproval === undefined ||
    input.sandboxRequired === undefined
  ) {
    unknownDimensions.push('safety/workflow resolution');
  }
  if (
    input.sandboxRequired !== undefined &&
    input.gateRequired &&
    input.gateSatisfied === undefined
  ) {
    unknownDimensions.push('validation gate');
  }
  if (unknownDimensions.length > 0) {
    rules.push(
      rule(
        3,
        'stage3-unknown-fail-closed',
        'DENY',
        `unknown or unresolvable input dimension(s): ${unknownDimensions.join(', ')}`,
      ),
    );
    return finalize(
      'DENY',
      'UNKNOWN_CAPABILITY',
      rules,
      obligations,
      `cannot establish a known, registered operation (${unknownDimensions.join(', ')})`,
    );
  }

  // Stage 4 — workflow permission.
  if (!input.workflowPermitted) {
    rules.push(
      rule(
        4,
        'stage4-workflow-not-permitted',
        'DENY',
        'the active workflow definition does not permit this action',
      ),
    );
    return finalize(
      'DENY',
      'WORKFLOW_NOT_PERMITTED',
      rules,
      obligations,
      'workflow scope does not include this action',
    );
  }

  // Stage 5 — hard ceilings: deny part short-circuits; floors contribute.
  if (input.ceilingEffect === 'DENY') {
    rules.push(
      rule(
        5,
        'stage5-autonomy-ceiling-deny',
        'DENY',
        'hard autonomy/global ceiling denies this action at every level',
      ),
    );
    return finalize(
      'DENY',
      'AUTONOMY_CEILING_EXCEEDED',
      rules,
      obligations,
      'the configured autonomy level cannot authorize this operation',
    );
  }
  if (input.ceilingEffect === 'REQUIRE_APPROVAL' || input.globalApprovalFloorMatch) {
    effect = 'REQUIRE_APPROVAL';
    rules.push(
      rule(
        5,
        'stage5-hard-approval-floor',
        'REQUIRE_APPROVAL',
        'a non-overridable approval floor applies to this action',
      ),
    );
  }

  // Stage 6 — contextual escalation may add restrictions/obligations only.
  if (input.contextRequiresApproval) {
    effect = strongest(effect, 'REQUIRE_APPROVAL');
    rules.push(
      rule(
        6,
        'stage6-context-escalation',
        'REQUIRE_APPROVAL',
        'trusted target/command/risk facts escalated this action',
      ),
    );
  }
  if (input.sandboxRequired) {
    obligations = [
      ...obligations,
      { kind: 'execution_environment', environment: 'sandbox_required' as ExecutionEnvironment },
    ];
  }

  // Stage 7 — validation gates must be satisfied BEFORE any allow path.
  if (input.gateRequired && !input.gateSatisfied) {
    effect = strongest(effect, 'REQUIRE_APPROVAL');
    rules.push(
      rule(
        7,
        'stage7-validation-gate-open',
        'REQUIRE_APPROVAL',
        'required validation evidence is missing, stale or failed',
      ),
    );
  }

  // Explicit repository effects (never remove floors/denies above).
  if (input.explicitDenyMatch) {
    effect = strongest(effect, 'DENY');
    rules.push(
      rule(
        8,
        'repo-explicit-deny',
        'DENY',
        'canonical repository policy explicitly denies this action',
      ),
    );
  }
  if (
    input.explicitRequireApprovalMatch ||
    (input.mergesProtectedBranch ?? false) ||
    (input.targetsProtectedBranch ?? false)
  ) {
    effect = strongest(effect, 'REQUIRE_APPROVAL');
    rules.push(
      rule(
        8,
        'repo-policy-floor',
        'REQUIRE_APPROVAL',
        'repository policy requires durable human approval for this action',
      ),
    );
  }
  if (input.explicitAllowMatch) {
    rules.push(
      rule(
        8,
        'repo-explicit-allow',
        'ALLOW',
        'canonical repository policy explicitly allows this action',
      ),
    );
    if (effect === undefined) effect = 'ALLOW';
  }

  // Approval can only SATISFY an existing REQUIRE_APPROVAL, never weaken DENY.
  if (
    effect === 'REQUIRE_APPROVAL' &&
    input.exactValidApprovalPresent &&
    !(input.gateRequired && !input.gateSatisfied)
  ) {
    rules.push(
      rule(
        7,
        'approval-satisfies-floor',
        'ALLOW',
        'exact fresh authorized approval satisfies the outstanding requirement',
      ),
    );
    effect = 'ALLOW';
  }

  // Stage 9 — risk defaults when nothing explicit decided.
  if (effect === undefined) {
    switch (input.riskClass) {
      case 'read':
        effect = 'ALLOW';
        rules.push(
          rule(
            9,
            'risk-default-read',
            'ALLOW',
            'known read action with no applicable restriction defaults to allow within workflow/ceiling checks already passed',
          ),
        );
        break;
      case 'reversible_write':
        effect = 'ALLOW';
        rules.push(
          rule(
            9,
            'risk-default-reversible-write',
            'ALLOW',
            'known reversible write defaults to allow; sandbox/workspace obligations still attach',
          ),
        );
        break;
      case 'sensitive_write':
      case 'destructive':
      case 'external_side_effect':
        effect = 'REQUIRE_APPROVAL';
        rules.push(
          rule(
            9,
            'risk-default-elevated',
            'REQUIRE_APPROVAL',
            `${String(input.riskClass)} defaults to human approval absent explicit policy`,
          ),
        );
        break;
      default:
        rules.push(
          rule(
            10,
            'no-rule-fail-closed',
            'DENY',
            'no rule or default mapping exists for this input',
          ),
        );
        return finalize(
          'DENY',
          'NO_APPLICABLE_RULE',
          rules,
          [],
          'fail closed: nothing authorizes this operation',
        );
    }
  }

  const finalEffect: DecisionEffect = effect;
  // Obligations can never weaken an effect (property guard).
  void obligations;
  return finalize(finalEffect, reasonFrom(rules), rules, obligations);
}

function reasonFrom(rules: readonly MatchedRule[]): string {
  const decisive =
    [...rules].reverse().find((entry) => entry.effect !== 'ALLOW') ?? rules[rules.length - 1];
  return decisive
    ? decisive.ruleId
        .replace(/^stage\d+-/, '')
        .toUpperCase()
        .slice(0, 64)
    : 'EVALUATED';
}

function finalize(
  effect: DecisionEffect,
  reasonCode: string,
  rules: readonly MatchedRule[],
  obligations: readonly Obligation[],
  explanationOverride?: string,
): EvaluationOutcome {
  const explanation =
    explanationOverride ??
    rules.map((entry) => `[${entry.stage}] ${entry.ruleId}: ${entry.explanation}`).join('; ');
  return Object.freeze({
    effect,
    reasonCode,
    matchedRules: Object.freeze(
      [...rules].sort((a, b) => a.stage - b.stage || a.ruleId.localeCompare(b.ruleId)),
    ),
    obligations: Object.freeze(obligations),
    explanation,
  });
}

/**
 * Mid-run merge semantics (C030 §12 tail): the run's snapshot produced
 * `snapshotResult`; current versions produce `currentResult`. A CURRENT
 * stricter restriction always wins; a CURRENT looser rule never silently
 * elevates — a fresh request/decision is required instead.
 */
export function mergeSnapshotWithCurrent(
  snapshotResult: EvaluationOutcome,
  currentResult: EvaluationOutcome,
): { effect: DecisionEffect; requireFreshDecision: boolean; explanation: string } {
  const rankOf = (candidate: DecisionEffect): number =>
    candidate === 'DENY' ? 2 : candidate === 'REQUIRE_APPROVAL' ? 1 : 0;
  if (rankOf(currentResult.effect) > rankOf(snapshotResult.effect)) {
    return {
      effect: currentResult.effect,
      requireFreshDecision: false,
      explanation: `current stricter policy applies: ${currentResult.reasonCode} overrides snapshot ${snapshotResult.effect}`,
    };
  }
  if (rankOf(currentResult.effect) < rankOf(snapshotResult.effect)) {
    return {
      effect: snapshotResult.effect,
      requireFreshDecision: true,
      explanation:
        'current policy is looser than the run snapshot; NO silent elevation — a fresh proposal/decision (and fresh approval where applicable) is required',
    };
  }
  return {
    effect: snapshotResult.effect,
    requireFreshDecision: false,
    explanation: 'snapshot and current agree',
  };
}

export type { AutonomyLevel };

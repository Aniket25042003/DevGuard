/**
 * C025 §5/§8/§22 — versioned context risk rules and the pure classifier.
 *
 * Invariants:
 * - Rules are pure functions over trusted context; sorted by stable rule ID,
 *   so results never depend on registration order.
 * - The join is monotonic: classification can only preserve or escalate.
 * - Required-but-missing or untrusted safety facts → confidence UNKNOWN
 *   (fail closed downstream in C030).
 * - Repository/model/tool-result content can never lower risk (§4.3).
 */
import { createHash } from 'node:crypto';
import type {
  ActionContext,
  Classification,
  LatticeRisk,
  Provenance,
  RiskFactor,
} from './lattice.js';
import { isTrustedFact, joinRisks } from './lattice.js';

export const CLASSIFIER_VERSION = 'classifier@1';

export interface ContextRiskRule {
  readonly id: string;
  /** Facts this rule needs; missing trusted ones flip the whole result to UNKNOWN. */
  readonly requiresFacts?: readonly string[];
  readonly matches: (context: ActionContext) => boolean;
  /** The escalation this rule applies when it matches. */
  readonly escalateTo: LatticeRisk;
  readonly obligations?: readonly string[];
  readonly explanation: string;
}

/** Canonical sensitive-path fragments (C025 §27: catalog owned by security review). */
const SENSITIVE_PATH_FRAGMENTS = [
  '.github/workflows/',
  '.circleci/',
  'dockerfile',
  'terraform/',
  '.github/security',
  'security/',
] as const;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function looksSensitivePath(path: string): boolean {
  const normalized = normalizePath(path);
  return SENSITIVE_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Ordered by stable ID; the engine iterates in this order regardless of input. */
export const CONTEXT_RISK_RULES: readonly ContextRiskRule[] = Object.freeze(
  (
    [
      {
        id: 'rule-01-protected-branch-write',
        matches: (c) =>
          c.target.protected === true ||
          [c.target.ref, c.target.id, c.operation.targetRef].some(
            (ref) => ref === 'main' || ref === 'master',
          ),
        escalateTo: 'sensitive_write' as const,
        explanation: 'target is a protected/default branch',
      },
      {
        id: 'rule-02-sensitive-path',
        matches: (c) => {
          const paths = [
            ...(c.operation.paths ?? []),
            ...(c.operation.path ? [c.operation.path] : []),
          ];
          return paths.some(looksSensitivePath);
        },
        escalateTo: 'sensitive_write' as const,
        explanation: 'operation touches CI/security/infrastructure configuration paths',
      },
      {
        id: 'rule-03-force-history-rewrite',
        matches: (c) =>
          c.workflowId === 'op.history_rewrite' &&
          (c.target.kind === 'branch' || c.target.kind === 'repository'),
        escalateTo: 'destructive' as const,
        explanation: 'history rewrite on branch/repository target',
      },
      {
        id: 'rule-04-permanent-deletion',
        matches: (c) =>
          c.actor === 'agent' && c.target.kind === 'repository' && c.workflowId === 'op.delete',
        escalateTo: 'destructive' as const,
        explanation: 'permanent deletion proposed by agent actor',
      },
      {
        id: 'rule-05-production-environment',
        matches: (c) => c.target.environment === 'production',
        escalateTo: 'external_side_effect' as const,
        obligations: ['approval.privileged'],
        explanation: 'target environment is production',
      },
      {
        id: 'rule-06-external-network-effect',
        matches: (c) => c.workflowId.startsWith('ext.'),
        escalateTo: 'external_side_effect' as const,
        explanation: 'workflow declared external network side effect',
      },
      {
        id: 'rule-07-breadth-limit',
        matches: (c) => (c.operation.paths?.length ?? 0) > 50,
        escalateTo: 'sensitive_write' as const,
        explanation: 'change breadth exceeds 50 paths in one operation',
      },
    ] as readonly ContextRiskRule[]
  )
    .slice()
    .sort((a: ContextRiskRule, b: ContextRiskRule) => a.id.localeCompare(b.id)),
);

/** Default obligations attached to sandbox/workspace actions per C024/C026 contract. */
const BASE_OBLIGATIONS = Object.freeze(['sandbox_only', 'timeout_required']);

function factByName(
  context: ActionContext,
  name: string,
): { value: unknown; provenance: Provenance } | undefined {
  for (const fact of context.facts) {
    if (fact.kind === name && isTrustedFact(fact.kind, fact.provenance)) {
      return { value: fact.value, provenance: fact.provenance };
    }
  }
  return undefined;
}

/**
 * Pure classifier. Unknown-required-fact handling: if a rule that WOULD match
 * needs a trusted fact which is absent, the entire classification becomes
 * UNKNOWN (fail closed, C025 §5).
 */
export function classify(
  baselineRisk: LatticeRisk,
  context: ActionContext,
  rules: readonly ContextRiskRule[] = CONTEXT_RISK_RULES,
): Classification {
  let effective = baselineRisk;
  const factors: RiskFactor[] = [];
  const obligations = new Set<string>(BASE_OBLIGATIONS);

  // Deterministic context fingerprint from canonical serialization inputs.
  const fingerprintInput = JSON.stringify([
    baselineRisk,
    context.repositoryId,
    context.workflowId,
    context.actor,
    context.target,
    context.operation,
    // Only stable projections of facts enter the fingerprint: kind + version,
    // never raw values that may contain timestamps of fetch alone.
    context.facts
      .map((f) => [f.kind, f.value, f.provenance.source, f.provenance.version ?? null])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
  const inputFingerprint = createHash('sha256').update(fingerprintInput).digest('hex');

  for (const rule of rules) {
    if (!rule.matches(context)) continue;
    // A matched escalation that requires trusted confirmation must be
    // verifiable — absence of those facts fails the WHOLE classification
    // closed (C025 §5/§18), never silently applies without evidence.
    const unverified = (rule.requiresFacts ?? []).some(
      (requirement) => !factByName(context, requirement),
    );
    if (unverified) {
      return {
        baselineRisk,
        effectiveRisk: 'unknown',
        factors,
        obligations: [...obligations],
        confidence: 'UNKNOWN',
        classifierVersion: CLASSIFIER_VERSION,
        inputFingerprint,
      };
    }
    effective = joinRisks(effective, rule.escalateTo);
    factors.push({ ruleId: rule.id, explanation: rule.explanation });
    for (const obligation of rule.obligations ?? []) obligations.add(obligation);
  }

  return {
    baselineRisk,
    effectiveRisk: effective,
    factors,
    obligations: [...obligations].sort(),
    confidence: 'DETERMINATE',
    classifierVersion: CLASSIFIER_VERSION,
    inputFingerprint,
  };
}

/** Compare two classifications of the same action across time (C025 §12). */
export function compareClassifications(
  previous: Pick<Classification, 'effectiveRisk' | 'inputFingerprint'>,
  current: Classification,
): { changed: boolean; escalated: boolean; staleApproval: boolean } {
  const rank = (risk: string): number =>
    risk === 'unknown'
      ? Number.MAX_SAFE_INTEGER
      : ({
          read: 0,
          reversible_write: 1,
          sensitive_write: 2,
          destructive: 3,
          external_side_effect: 3,
        }[risk] ?? -1);
  const escalated =
    current.effectiveRisk === 'unknown' ||
    rank(current.effectiveRisk) > rank(previous.effectiveRisk);
  const changed = previous.inputFingerprint !== current.inputFingerprint;
  return { changed, escalated, staleApproval: escalated };
}

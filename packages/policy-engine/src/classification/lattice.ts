/**
 * C025 §8/§22 — risk lattice and trusted context schemas.
 *
 * Restriction lattice (C025 §8): READ < WRITE_REVERSIBLE < WRITE_SENSITIVE <
 * {DESTRUCTIVE, EXTERNAL_SIDE_EFFECT}. DESTRUCTIVE and EXTERNAL_SIDE_EFFECT
 * are incomparable terminal classes; both may apply and BOTH factors are
 * retained. Adding a factor can never reduce restriction (monotonic join).
 */
import { z } from 'zod';

export const RISK_LATTICE = [
  'read',
  'reversible_write',
  'sensitive_write',
  'destructive',
  'external_side_effect',
] as const;

export type LatticeRisk = (typeof RISK_LATTICE)[number];

const RANK: Readonly<Record<LatticeRisk, number>> = Object.freeze({
  read: 0,
  reversible_write: 1,
  sensitive_write: 2,
  destructive: 3,
  external_side_effect: 3,
});

/** Monotonic join: strongest applicable restriction wins; ties keep both. */
export function joinRisks(a: LatticeRisk, b: LatticeRisk): LatticeRisk {
  if (RANK[a] > RANK[b]) return a;
  if (RANK[b] > RANK[a]) return b;
  return a === b ? a : ('destructive' as LatticeRisk); // terminal tie → destructive is the conservative floor
}

export function rankOf(risk: LatticeRisk): number {
  return RANK[risk];
}

/** True when moving from `from` to `to` preserved-or-escalated restriction. */
export function monotonic(from: LatticeRisk, to: LatticeRisk): boolean {
  return RANK[to] >= RANK[from];
}

/** Trusted target descriptor supplied only by typed adapters/domain state. */
export const targetDescriptor = z
  .object({
    kind: z.enum([
      'repository',
      'branch',
      'tag',
      'pull_request',
      'issue',
      'file',
      'workflow_run',
      'deployment',
    ]),
    id: z.string().min(1).max(256),
    ref: z.string().max(256).optional(),
    protected: z.boolean().optional(),
    environment: z.enum(['sandbox', 'development', 'staging', 'production']).optional(),
  })
  .strict();

/**
 * A fact must declare where it came from and when it was observed. Facts from
 * untrusted sources can NEVER lower risk — the rules engine simply ignores
 * non-trusted provenance for safety-relevant predicates.
 */
export const provenance = z
  .object({
    source: z.enum([
      'github_adapter',
      'policy_service',
      'domain_state',
      'sandbox_runtime',
      'untrusted_model',
      'repository_content',
    ]),
    fetchedAt: z.string().max(64),
    version: z.string().max(64).optional(),
  })
  .strict();

export const actionContext = z
  .object({
    repositoryId: z.string().min(1).max(128),
    workflowId: z.string().min(1).max(128),
    actor: z.enum(['agent', 'user', 'webhook', 'system']),
    target: targetDescriptor,
    /** Operation metadata extracted by C024's tool registry. */
    operation: z
      .object({
        targetRef: z.string().max(256).optional(),
        baseSha: z.string().max(64).optional(),
        headSha: z.string().max(64).optional(),
        path: z.string().max(1024).optional(),
        paths: z.array(z.string().max(1024)).max(200).optional(),
        commandFingerprint: z.string().max(128).optional(),
      })
      .strip(),
    facts: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            value: z.unknown(),
            provenance,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

export type ActionContext = z.output<typeof actionContext>;
export type Provenance = z.output<typeof provenance>;

export function isTrustedFact(factKind: string, prov: Provenance): boolean {
  void factKind;
  return ['github_adapter', 'policy_service', 'domain_state', 'sandbox_runtime'].includes(
    prov.source,
  );
}

/** A single escalation with its explanation, stable across permutations. */
export interface RiskFactor {
  readonly ruleId: string;
  readonly explanation: string;
}

export interface Classification {
  readonly baselineRisk: LatticeRisk;
  readonly effectiveRisk: LatticeRisk | 'unknown';
  readonly factors: readonly RiskFactor[];
  readonly obligations: readonly string[];
  readonly confidence: 'DETERMINATE' | 'UNKNOWN';
  readonly classifierVersion: string;
  readonly inputFingerprint: string;
}

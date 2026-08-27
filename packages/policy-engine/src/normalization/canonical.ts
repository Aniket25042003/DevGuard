/**
 * C023 §5/§8/§17 — conservative defaults and canonical serialization.
 *
 * Normalization contract:
 * - omitted grant collections become EMPTY sets (no rule ⇒ no permission)
 * - omitted autonomy.level never widens (caller supplies an explicit level
 *   only for the system onboarding template)
 * - omitted limits fall back to POLICY_LIMIT_DEFAULTS, capped globally
 * - canonical JSON: recursively sorted object keys, NFC-normalized strings,
 *   integers-only limits, no undefined values
 * - canonicalize(canonicalize(x)) === canonicalize(x), byte-for-byte
 */
import { createHash } from 'node:crypto';
import type { CanonicalPolicyDocument, PolicyLimits } from '../schema/policy-v1.js';
import {
  POLICY_LIMIT_DEFAULTS,
  POLICY_LIMIT_GLOBAL_CAPS,
  repositoryPolicyV1,
  type RepositoryPolicyV1,
} from '../schema/policy-v1.js';

/** Sorted, deduplicated readonly array helper. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.normalize('NFC')))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Recursively sort object keys; strings are Unicode NFC normalized. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortedDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'string') return value.normalize('NFC');
  return value;
}

/**
 * Canonical JSON: JSON.stringify over deeply key-sorted, NFC values with no
 * whitespace. Input must already be schema-validated (numbers finite).
 */
export function canonicalJson(policy: CanonicalPolicyDocument): string {
  return JSON.stringify(sortedDeep(policy));
}

/** Content-addressed identity including schema version (C023 §8/§17). */
export function canonicalHash(policy: CanonicalPolicyDocument): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

/** Effective bounded limit resolution: policy value or system default. */
export function effectiveLimits(
  input: { readonly [K in keyof PolicyLimits]?: number | undefined } = {},
): PolicyLimits {
  return {
    maxFilesChanged: Math.min(
      input.maxFilesChanged ?? POLICY_LIMIT_DEFAULTS.maxFilesChanged,
      POLICY_LIMIT_GLOBAL_CAPS.maxFilesChanged,
    ),
    maxIterations: Math.min(
      input.maxIterations ?? POLICY_LIMIT_DEFAULTS.maxIterations,
      POLICY_LIMIT_GLOBAL_CAPS.maxIterations,
    ),
    maxRuntimeMinutes: Math.min(
      input.maxRuntimeMinutes ?? POLICY_LIMIT_DEFAULTS.maxRuntimeMinutes,
      POLICY_LIMIT_GLOBAL_CAPS.maxRuntimeMinutes,
    ),
  };
}

/**
 * Normalize a validated V1 policy into its canonical shape. The caller has
 * already applied semantic validation; autonomy.level is required here by the
 * V1 schema itself (never defaulted).
 */
export function normalizePolicyV1(validated: RepositoryPolicyV1): CanonicalPolicyDocument {
  return deepFreeze({
    schemaVersion: 1 as const,
    repository: {
        owner: validated.repository.owner.toLowerCase(),
        name: validated.repository.name.toLowerCase(),
      },
    autonomy: { level: validated.autonomy.level },
    triggers: Object.freeze(
      Object.fromEntries(
        Object.entries(validated.triggers).map(([trigger, workflows]) => [
          trigger,
          sortedUnique(workflows),
        ]),
      ),
    ) as Readonly<Record<string, readonly string[]>>,
    manualCommands: sortedUnique(validated.manualCommands),
    actions: Object.freeze({
      allow: sortedUnique(validated.actions.allow),
      requireApproval: sortedUnique(validated.actions.requireApproval),
      deny: sortedUnique(validated.actions.deny),
    }),
    validation: Object.freeze({ obligations: sortedUnique(validated.validation.obligations) }),
    limits: Object.freeze(effectiveLimits(validated.limits)),
  });
}

/** Idempotence check per C023 §10: canonicalizing twice yields equal bytes. */
export function canonicalizationIsStable(policy: CanonicalPolicyDocument): boolean {
  const once = canonicalJson(policy);
  const reparsed = repositoryPolicyV1.parse(JSON.parse(once)) as RepositoryPolicyV1;
  const twice = canonicalJson(normalizePolicyV1(reparsed));
  return once === twice;
}

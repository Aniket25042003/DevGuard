/**
 * C002 — Typed feature-flag registry and evaluation.
 *
 * Invariants:
 * - Flags only ever NARROW capability. They can never bypass policy,
 *   repository authorization, approval, sandboxing, or auditing.
 * - Evaluation precedence: code default < environment override. Persisted
 *   scoped overrides (ADR-0005) would slot after environment when introduced.
 * - Unknown flag keys fail closed.
 */
import type { SecretProvider } from './secrets.js';

export const FEATURE_KEYS = [
  /** GitHub mutation adapter reachable (gated additionally by W0–W6 evidence). */
  'githubWritesEnabled',
  /** TrueForge runtime integration wired (contract-verified by C036 first). */
  'trueforgeIntegrationEnabled',
  /** Sandbox command execution permitted (requires trueforgeIntegrationEnabled). */
  'sandboxExecutionEnabled',
  /** Webhook ingress accepts deliveries (C022/C075). */
  'webhookIngressEnabled',
  /** Approval-gated privileged execution may run (C034/C035 wired). */
  'approvalExecutionEnabled',
  /** Development-only no-auth mode; rejected outside development/test. */
  'devNoAuthMode',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureDefaults = Readonly<Record<FeatureKey, boolean>>;

/** Conservative production-safe defaults: every risky capability starts off. */
export const FEATURE_DEFAULTS: FeatureDefaults = Object.freeze({
  githubWritesEnabled: false,
  trueforgeIntegrationEnabled: false,
  sandboxExecutionEnabled: false,
  webhookIngressEnabled: false,
  approvalExecutionEnabled: false,
  devNoAuthMode: false,
});

export type FlagSource = 'default' | 'environment';

export interface FlagDecision<K extends FeatureKey = FeatureKey> {
  readonly key: K;
  readonly value: boolean;
  readonly source: FlagSource;
}

/** Complete decision set for one process snapshot. */
export type FeatureDecisionSet = Readonly<Record<FeatureKey, FlagDecision>>;

const FLAG_ENV_PREFIX = 'FLAG_';

function flagEnvName(key: FeatureKey): string {
  return FLAG_ENV_PREFIX + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function parseStrictBoolean(raw: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

export class FeatureFlagError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = 'FeatureFlagError';
    this.key = key;
  }
}

export interface FeatureEvaluation {
  readonly decisions: Readonly<Record<FeatureKey, FlagDecision>>;
  /** Issues that make the configuration invalid (fail closed at startup). */
  readonly issues: ReadonlyArray<{ path: string; constraint: string }>;
  /** Non-fatal notes (e.g., override equals default). */
  readonly warnings: readonly string[];
}

/** Evaluate all flags from defaults plus strict boolean environment overrides. */
export function evaluateFeatures(
  env: Readonly<Record<string, string | undefined>>,
): FeatureEvaluation {
  const decisions = {} as Record<FeatureKey, FlagDecision>;
  const issues: Array<{ path: string; constraint: string }> = [];
  const warnings: string[] = [];

  for (const key of FEATURE_KEYS) {
    const envName = flagEnvName(key);
    const raw = env[envName];
    if (raw === undefined || raw === '') {
      decisions[key] = { key, value: FEATURE_DEFAULTS[key], source: 'default' };
      continue;
    }
    const parsed = parseStrictBoolean(raw);
    if (parsed === undefined) {
      issues.push({ path: envName, constraint: 'must be exactly "true" or "false"' });
      decisions[key] = { key, value: false, source: 'default' };
      continue;
    }
    decisions[key] = { key, value: parsed, source: 'environment' };
    if (parsed === FEATURE_DEFAULTS[key]) {
      warnings.push(`${envName} matches the code default`);
    }
  }

  // Safety narrowing: enabling sandbox execution requires the TrueForge runtime.
  if (
    decisions['sandboxExecutionEnabled'].value &&
    !decisions['trueforgeIntegrationEnabled'].value
  ) {
    issues.push({
      path: flagEnvName('sandboxExecutionEnabled'),
      constraint: 'requires FLAG_TRUEFORGE_INTEGRATION_ENABLED=true',
    });
    decisions['sandboxExecutionEnabled'] = {
      key: 'sandboxExecutionEnabled',
      value: false,
      source: 'default',
    };
  }

  return { decisions, issues, warnings };
}

/** Runtime gate used by composition roots and services. */
export interface FlagContext {
  readonly environment: string;
}

export interface FeatureGate {
  evaluate<K extends FeatureKey>(key: K, context?: FlagContext): FlagDecision<K>;
}

export function createFeatureGate(
  decisions: Readonly<Record<FeatureKey, FlagDecision>>,
  _secretProvider?: SecretProvider,
): FeatureGate {
  return {
    evaluate<K extends FeatureKey>(key: K): FlagDecision<K> {
      const decision = decisions[key];
      if (!decision) {
        throw new FeatureFlagError(key, `Unknown feature key '${String(key)}'.`);
      }
      return decision as FlagDecision<K>;
    },
  };
}

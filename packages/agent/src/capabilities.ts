/**
 * C036 §8/§10/§13 — provider capability matrix and compatibility decision.
 *
 * TrueForge (or any provider) owns the agent loop; DevGuard only consumes
 * verified capabilities. This module names the finite capability set, marks
 * which are mandatory (safety-critical — their absence fails readiness), which
 * are optional (absence degrades), and which observed provider properties are
 * fatal (their PRESENCE fails readiness). Unknown capability names fail closed.
 *
 * The decision here is pure: given a set of verified claims it yields
 * COMPATIBLE | DEGRADED | INCOMPATIBLE. The state machine lives in
 * `compatibility.ts`; snapshots in `snapshot.ts`.
 */
export const AGENT_CAPABILITIES = [
  'session_create',
  'session_get',
  'turn_create',
  'turn_get',
  'one_active_turn',
  'event_stream',
  'event_cursor',
  'event_delta',
  'event_replay',
  'mcp_interception',
  'required_action_resume',
  'checkpoint_replay',
  'sandbox',
  'cancellation',
  'subagents',
  'context_compaction',
  'final_response',
  'idempotency_semantics',
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const ALL_AGENT_CAPABILITIES: readonly AgentCapability[] = Object.freeze([
  ...AGENT_CAPABILITIES,
]);

/**
 * Mandatory capabilities. Absence of any one of these means the runtime cannot
 * fulfil DevGuard's non-negotiable safety flows and readiness fails closed.
 */
export const MANDATORY_CAPABILITIES: readonly AgentCapability[] = Object.freeze([
  'session_create',
  'session_get',
  'turn_create',
  'turn_get',
  'one_active_turn',
  'event_stream',
  'mcp_interception',
  'required_action_resume',
]);

/** Optional capabilities; absence degrades but does not block startup. */
export const OPTIONAL_CAPABILITIES: readonly AgentCapability[] = Object.freeze(
  AGENT_CAPABILITIES.filter((name) => !MANDATORY_CAPABILITIES.includes(name)),
);

/**
 * Fatal observed provider properties. Presence forces INCOMPATIBLE: the plan
 * (C036 §16) requires the capability matrix to prove direct mutative GitHub MCP
 * tools are disabled or routed through C039; until C039 routes them, DevGuard
 * never adopts a runtime that can mutate GitHub outside the governed path.
 */
export const FATAL_PROVIDER_PROPERTIES = ['direct_mutative_github_tools'] as const;
export type FatalProviderProperty = (typeof FATAL_PROVIDER_PROPERTIES)[number];

/** A single capability claim produced by a verification probe. */
export interface CapabilityClaim {
  readonly name: string;
  /** True only when verified true by an actual fixture/probe, never assumed. */
  readonly verified: boolean;
  /** Bounded reason when unverified; never injected into safe messages. */
  readonly reason?: string | undefined;
}

export type CapabilityVerdict = 'COMPATIBLE' | 'DEGRADED' | 'INCOMPATIBLE';

export interface CapabilityEvaluation {
  readonly verdict: CapabilityVerdict;
  /** Mandatory capabilities that were NOT verified (null-safe message reasons). */
  readonly missingMandatory: readonly string[];
  /** Optional capabilities that were NOT verified. */
  readonly missingOptional: readonly string[];
  /** Present fatal properties (quarantined capability names safe to log). */
  readonly fatalPresent: readonly string[];
  /** Claim names that are not in the known capability set (fail closed). */
  readonly unknownClaims: readonly string[];
}

function missingNames(
  claims: ReadonlyMap<string, boolean>,
  expected: readonly AgentCapability[],
): string[] {
  const out: string[] = [];
  for (const name of expected) {
    if (claims.get(name) !== true) out.push(name);
  }
  return out;
}

/**
 * Pure decision over a verified-claims map. Unknown/absent capabilities fail
 * closed; returns a verdict plus the exact capability names to report.
 */
export function evaluateCapabilities(
  claims: ReadonlyMap<string, boolean>,
  fatalPropertiesPresent: readonly string[] = [],
): CapabilityEvaluation {
  const missingMandatory = missingNames(claims, MANDATORY_CAPABILITIES);
  const missingOptional = missingNames(claims, OPTIONAL_CAPABILITIES);
  const unknownClaims: string[] = [];
  for (const name of claims.keys()) {
    if (!(AGENT_CAPABILITIES as readonly string[]).includes(name)) unknownClaims.push(name);
  }

  const fatalOnlyKnown = fatalPropertiesPresent.filter((name) =>
    (FATAL_PROVIDER_PROPERTIES as readonly string[]).includes(name),
  );

  if (fatalOnlyKnown.length > 0) {
    return {
      verdict: 'INCOMPATIBLE',
      missingMandatory,
      missingOptional,
      fatalPresent: fatalOnlyKnown,
      unknownClaims,
    };
  }
  if (missingMandatory.length > 0 || unknownClaims.length > 0) {
    return {
      verdict: 'INCOMPATIBLE',
      missingMandatory,
      missingOptional,
      fatalPresent: [],
      unknownClaims,
    };
  }
  if (missingOptional.length > 0) {
    return {
      verdict: 'DEGRADED',
      missingMandatory,
      missingOptional,
      fatalPresent: [],
      unknownClaims,
    };
  }
  return {
    verdict: 'COMPATIBLE',
    missingMandatory: [],
    missingOptional: [],
    fatalPresent: [],
    unknownClaims: [],
  };
}

export function isKnownCapability(name: string): boolean {
  return (AGENT_CAPABILITIES as readonly string[]).includes(name);
}

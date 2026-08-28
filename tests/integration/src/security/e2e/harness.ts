/**
 * C097 — Deterministic adversarial/durability scenario harness.
 *
 * A lightweight, dependency-free scenario runner that drives an act function on
 * a FAKE clock, collects persisted states, evaluates forbidden-effect checks,
 * scans every captured evidence byte for synthetic canaries, and returns a
 * digest-bound ScenarioEvidence. Failure to remain clean fails the scenario:
 * "SKIPPED is not a passing release state for required cases" (C097 §9).
 *
 * This is the deterministic in-memory subset of the C097 matrix (no real
 * PostgreSQL/Redis/browser/live-provider topology — those are the gated
 * provider/live suites). It still enforces the two core invariants that matter
 * everywhere: one-effective-effect under replay, and zero canary leakage.
 */
export interface ScenarioClock {
  now(): Date;
}

/** Simple fake clock: starts at an epoch and advances deterministically. */
export function fakeClock(startIso = '2026-01-01T00:00:00.000Z'): ScenarioClock & {
  readonly advance: (ms: number) => void;
} {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface ForbiddenEffectCheck {
  readonly id: string;
  readonly description: string;
  /** Returns true when the forbidden effect was OBSERVED (i.e. a violation). */
  readonly evaluate: () => boolean;
}

export interface ScenarioSpec {
  readonly id: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly description: string;
}

export interface ScenarioEvidence {
  readonly scenario: ScenarioSpec;
  readonly startIso: string;
  readonly endIso: string;
  /** Ordered durable states observed during the scenario. */
  readonly states: readonly string[];
  /** Ids of forbidden-effect checks that fired (empty => clean). */
  readonly forbiddenViolations: readonly string[];
  /** Synthetic canaries found in any captured evidence (empty => clean). */
  readonly canaryLeaks: readonly string[];
  readonly canariesScanned: readonly string[];
  readonly passed: boolean;
  /** SHA-256 digest of the canonical, immutable evidence snapshot. */
  readonly digest: string;
}

export interface ScenarioResult {
  readonly evidence: ScenarioEvidence;
  readonly forbiddenEffectChecks: readonly ForbiddenEffectCheck[];
}

/**
 * Execute a scenario and assemble its evidence.
 *
 * `act` runs the scenario body and returns the ordered states it persisted and
 * any raw evidence strings (logs, PR bodies, artifacts) that must be scanned
 * for canaries. `forbiddenEffects` are evaluated AFTER `act` completes (the
 * "oracle" snapshot pattern); `canaries` must not appear verbatim anywhere.
 */
export async function runScenario(
  spec: ScenarioSpec,
  act: (clock: ScenarioClock) => Promise<{
    readonly states: readonly string[];
    readonly evidence: readonly string[];
  }>,
  options: {
    readonly forbiddenEffects: readonly ForbiddenEffectCheck[];
    readonly canaries: readonly string[];
    readonly clock?: ScenarioClock;
  },
): Promise<ScenarioResult> {
  const clock = options.clock ?? fakeClock();
  const startIso = clock.now().toISOString();
  const { states, evidence } = await act(clock);
  const endIso = clock.now().toISOString();

  const forbiddenViolations = options.forbiddenEffects
    .filter((effect) => effect.evaluate())
    .map((effect) => effect.id);

  const canaryLeaks: string[] = [];
  for (const canary of options.canaries) {
    if (evidence.some((blob) => blob.includes(canary))) canaryLeaks.push(canary);
  }

  const snapshot = {
    scenario: { ...spec, tags: [...spec.tags] },
    startIso,
    endIso,
    states: [...states],
    forbiddenViolations: [...forbiddenViolations],
    canaryLeaks: [...canaryLeaks],
    canariesScanned: [...options.canaries],
    passed: forbiddenViolations.length === 0 && canaryLeaks.length === 0,
  } as const;
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const evidenceBundle: ScenarioEvidence = Object.freeze({ ...snapshot, digest });
  return { evidence: evidenceBundle, forbiddenEffectChecks: options.forbiddenEffects };
}

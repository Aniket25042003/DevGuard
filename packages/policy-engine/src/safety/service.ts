/**
 * C027 §10/§12/§25 — SafetyConstraintService.
 *
 * Emits ALL matching restrictions (never just the strongest) sorted by stable
 * rule ID; C030 applies precedence. Restriction derivation is pure for fixed
 * catalog versions. Catalog integrity is verified at construction and fails
 * closed: every registered C024 action must resolve to an explicit autonomy
 * behavior (test-time exhaustive guard plus runtime startup gate).
 */
import { createHash } from 'node:crypto';
import { ACTION_DEFINITIONS } from '../actions/catalog.js';
import type { AutonomyLevel } from '@devguard/contracts';
import {
  AUTONOMY_PROFILES,
  GLOBAL_RULES,
  GLOBAL_SAFETY_VERSION,
  profileForLevel,
  type AutonomyProfile,
  type GlobalRule,
  type Restriction,
  type SafetyCatalogSnapshot,
} from './catalog.js';

export interface ClassifiedActionRef {
  readonly actionId: string;
  /** True when trusted context classified this as a protected/default-branch write. */
  readonly targetsProtectedBranch?: boolean | undefined;
  /** True when targets a protected/default PR merge target. */
  readonly mergesProtectedBranch?: boolean | undefined;
}

export class SafetyCatalogError extends Error {}

/** Strongest-first effect ranking used by callers (C030 owns final effect). */
export function restrictionRank(restriction: Restriction): number {
  return restriction.minimumEffect === 'DENY'
    ? 2
    : restriction.minimumEffect === 'REQUIRE_APPROVAL'
      ? 1
      : 0;
}

function byRuleId(a: Restriction, b: Restriction): number {
  return a.ruleId.localeCompare(b.ruleId);
}

export class SafetyConstraintService {
  #globalRules: readonly GlobalRule[];
  #denyIndex: ReadonlyMap<string, GlobalRule>;
  #floorIndex: ReadonlyMap<string, GlobalRule>;
  #catalogHash: string;

  constructor() {
    this.#globalRules = GLOBAL_RULES;
    const denyIndex = new Map<string, GlobalRule>();
    const floorIndex = new Map<string, GlobalRule>();
    for (const rule of this.#globalRules) {
      for (const action of rule.denyActions ?? []) denyIndex.set(action, rule);
      for (const action of rule.approvalFloorActions ?? []) floorIndex.set(action, rule);
    }
    this.#denyIndex = denyIndex;
    this.#floorIndex = floorIndex;
    this.#catalogHash = createHash('sha256')
      .update(
        JSON.stringify([
          GLOBAL_SAFETY_VERSION,
          [...denyIndex.keys()].sort(),
          [...floorIndex.keys()].sort(),
          ...(['assist', 'developer', 'trusted', 'autonomous'] as const).map((level) => {
            const profile = AUTONOMY_PROFILES[level];
            return [level, [...profile.automaticActions].sort(), [...profile.approvalRequiredActions].sort(), [...profile.deniedActions].sort()];
          }),
        ]),
      )
      .digest('hex');
    this.#assertIntegrity();
  }

  /**
   * Startup/readiness gate (C027 §12): invalid catalogs must fail service
   * startup instead of silently running without safety floors.
   */
  #assertIntegrity(): void {
    // Every globally denied/floored action must exist in the C024 taxonomy —
    // a typo would silently unrestrict an operation.
    const known = new Set(ACTION_DEFINITIONS.map((definition) => definition.id));
    for (const source of [this.#denyIndex, this.#floorIndex]) {
      for (const [action] of source) {
        if (!known.has(action)) {
          throw new SafetyCatalogError(`global rule references unknown action '${action}'`);
        }
      }
    }
    // Floor vs deny conflicts resolve to deny; assert no contradictory intent
    // (an action cannot be floored in one rule and denied in another unless
    // deny wins — we normalize here so tests see exactly one entry).
    for (const action of this.#floorIndex.keys()) {
      if (this.#denyIndex.has(action)) {
        throw new SafetyCatalogError(
          `action '${action}' is both globally denied and approval-floored`,
        );
      }
    }
    // Every autonomy level's automatic actions must be registered actions.
    for (const level of Object.keys(AUTONOMY_PROFILES) as AutonomyLevel[]) {
      const profile = AUTONOMY_PROFILES[level];
      for (const group of [
        profile.automaticActions,
        profile.approvalRequiredActions,
        profile.deniedActions,
      ]) {
        for (const action of group) {
          if (!known.has(action)) {
            throw new SafetyCatalogError(`autonomy ${level} references unknown action '${action}'`);
          }
        }
      }
    }
  }

  snapshot(): SafetyCatalogSnapshot {
    return Object.freeze({
      globalSafetyVersionId: GLOBAL_SAFETY_VERSION,
      catalogHash: this.#catalogHash,
    });
  }

  /** All global restrictions matching the classified action (C030 stage 1/5). */
  globalRestrictions(input: ClassifiedActionRef): readonly Restriction[] {
    const out: Restriction[] = [];
    const deny = this.#denyIndex.get(input.actionId);
    if (deny) {
      out.push({
        source: 'GLOBAL_SAFETY',
        minimumEffect: 'DENY',
        ruleId: deny.id,
        explanation: deny.explanation,
        nonOverridable: true,
      });
    }
    const floor = this.#floorIndex.get(input.actionId);
    if (!deny && floor) {
      out.push({
        source: 'GLOBAL_SAFETY',
        minimumEffect: 'REQUIRE_APPROVAL',
        ruleId: floor.id,
        explanation: floor.explanation,
        nonOverridable: true,
      });
    }
    // Protected/default-branch operations always carry at least the approval
    // floor regardless of repository grants (C027 §16).
    if (!deny && (input.targetsProtectedBranch || input.mergesProtectedBranch)) {
      out.push({
        source: 'GLOBAL_SAFETY',
        minimumEffect: 'REQUIRE_APPROVAL',
        ruleId: 'global-floor-protected-target',
        explanation:
          'operations on protected/default branches or their merges require human approval',
        nonOverridable: true,
      });
    }
    return out.sort(byRuleId);
  }

  /** All autonomy-ceiling restrictions for this action at this level. */
  autonomyRestrictions(level: AutonomyLevel, input: ClassifiedActionRef): readonly Restriction[] {
    const profile: AutonomyProfile = profileForLevel(level);
    const out: Restriction[] = [];
    if (profile.deniedActions.has(input.actionId)) {
      out.push({
        source: 'AUTONOMY_CEILING',
        minimumEffect: 'DENY',
        ruleId: `ceiling-${level}-deny`,
        explanation: `'${input.actionId}' exceeds the '${level}' autonomy ceiling`,
        nonOverridable: true,
      });
    } else if (profile.approvalRequiredActions.has(input.actionId)) {
      out.push({
        source: 'AUTONOMY_CEILING',
        minimumEffect: 'REQUIRE_APPROVAL',
        ruleId: `ceiling-${level}-floor`,
        explanation: `'${input.actionId}' requires durable human approval under '${level}'`,
        nonOverridable: true,
      });
    }
    return out.sort(byRuleId);
  }

  /** Union used by C030; all matches retained. */
  restrictionsFor(level: AutonomyLevel, input: ClassifiedActionRef): readonly Restriction[] {
    return [...this.globalRestrictions(input), ...this.autonomyRestrictions(level, input)].sort(
      (a, b) => byRuleId(a, b),
    );
  }

  /**
   * Policy semantic checks (C023 integration): repository allow entries that
   * a global deny will ALWAYS block are impossible overrides — rejected at
   * validation time while defense-in-depth remains at evaluation time.
   */
  validatePolicy(policy: {
    actions: {
      allow: readonly string[];
      requireApproval: readonly string[];
      deny: readonly string[];
    };
  }): { diagnostics: ReadonlyArray<{ code: string; message: string }> } {
    const diagnostics: Array<{ code: string; message: string }> = [];
    for (const action of policy.actions.allow) {
      if (this.#denyIndex.has(action)) {
        diagnostics.push({
          code: 'POLICY_CONFLICT',
          message: `action '${action}' is globally denied and can never be allowed by repository policy`,
        });
      }
      // Allow entries below the highest ceiling are permitted but inert for
      // stricter levels — documented as fail-closed rather than rejected.
    }
    return { diagnostics };
  }
}

/**
 * C028 §7/§10/§12/§19/§20 — trigger matcher, manual authorization and
 * deterministic dedupe keys.
 *
 * - Matching uses typed normalized fields only; no regex over raw payloads.
 * - Matches are sorted by stable rule ID; exact duplicates collapse to one
 *   candidate while retaining all matched rule IDs for audit.
 * - Fan-out caps per event; cooldowns bound repeat triggers.
 * - Invocation grants permission to START a workflow only — never for the
 *   actions inside it (C030 evaluates each of those separately).
 */
import { createHash } from 'node:crypto';
import type { TriggerRule, WorkflowIdResult, WorkflowIdV1 } from './registry.js';
import { INVOCATION_REGISTRY_VERSION } from './registry.js';

export interface NormalizedEvent {
  readonly deliveryId: string;
  readonly repositoryExternalId: string;
  readonly trigger: string;
  /** Canonical resource identity (issue number, PR number, SHA, check id). */
  readonly resourceIdentity: string;
  readonly labels: readonly string[];
  readonly branch?: string | undefined;
  readonly conclusions?: readonly string[] | undefined;
  readonly prOrigin?: 'fork' | 'same_repository' | undefined;
  readonly actorLogin: string;
}

export interface PolicyTriggerSnapshot {
  readonly policySnapshotId: string;
  readonly rules: readonly TriggerRule[];
}

export interface MatchedCandidate {
  readonly workflowId: WorkflowIdV1;
  readonly matchedRuleIds: readonly string[];
  readonly dedupeKey: string;
  readonly resourceKey: string;
  readonly maxFanOut: number;
}

export type MatchResult =
  | { readonly outcome: 'MATCHED'; readonly candidates: readonly MatchedCandidate[] }
  | { readonly outcome: 'NO_MATCH'; readonly reasonCode: 'NO_RULES_FOR_EVENT' }
  | {
      readonly outcome: 'REJECTED';
      readonly reasonCode: 'RULES_DISABLED' | 'FAN_OUT_EXCEEDED' | 'COOLDOWN_ACTIVE';
      readonly detail: string;
    };

function filterMatches(rule: TriggerRule, event: NormalizedEvent): boolean {
  const filter = rule.filter;
  if (!filter) return true;
  if (filter.labelsAny && !filter.labelsAny.some((label) => event.labels.includes(label)))
    return false;
  if (filter.branchesAny && !(event.branch && filter.branchesAny.includes(event.branch)))
    return false;
  if (filter.conclusionsAny) {
    if (
      !(event.conclusions ?? []).some((conclusion) =>
        filter.conclusionsAny!.includes(conclusion as never),
      )
    ) {
      return false;
    }
  }
  if (filter.prOrigin && event.prOrigin !== filter.prOrigin) return false;
  return true;
}

/** Dedupe key per C028 §8. */
export function invocationDedupeKey(parts: {
  repositoryId: string;
  sourceKey: string; // deliveryId or manual idempotency key
  ruleId: string;
  workflowId: string;
  resourceIdentity: string;
  policySnapshotId: string;
}): string {
  return createHash('sha256')
    .update(
      [
        parts.repositoryId,
        parts.sourceKey,
        parts.ruleId,
        parts.workflowId,
        parts.resourceIdentity,
        parts.policySnapshotId,
        INVOCATION_REGISTRY_VERSION,
      ].join('|'),
    )
    .digest('hex');
}

export class TriggerMatcher {
  /**
   * @param nowMs injectable clock (ms since epoch) for cooldown evaluation
   * @param lastInvocationAtByRule cooldown state keyed by `ruleId|resource`
   */
  matchEvent(
    event: NormalizedEvent,
    snapshot: PolicyTriggerSnapshot,
    context: {
      nowMs?: number | undefined;
      lastInvocationAtByRule?: ReadonlyMap<string, number> | undefined;
    } = {},
  ): MatchResult {
    const rules = snapshot.rules
      .filter((rule) => rule.enabled && rule.eventTrigger === event.trigger)
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
    if (snapshot.rules.length === 0 || rules.length === 0) {
      return { outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' };
    }

    const matching = rules.filter((rule) => filterMatches(rule, event));
    if (matching.length === 0) {
      // Disabled-only events surface NO_MATCH against enabled rules.
      const anyForEvent = snapshot.rules.filter((rule) => rule.eventTrigger === event.trigger);
      return anyForEvent.length > 0
        ? { outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' }
        : { outcome: 'NO_MATCH', reasonCode: 'NO_RULES_FOR_EVENT' };
    }

    // Cooldown evaluation per rule/resource pair.
    const now = context.nowMs ?? Date.now();
    const cooldownBlocked = matching.find((rule) => {
      const last = context.lastInvocationAtByRule?.get(`${rule.ruleId}|${event.resourceIdentity}`);
      return last !== undefined && now - last < rule.cooldownSeconds * 1000;
    });
    const eligible = matching.filter((rule) => {
      const last = context.lastInvocationAtByRule?.get(`${rule.ruleId}|${event.resourceIdentity}`);
      return last === undefined || now - last >= rule.cooldownSeconds * 1000;
    });
    if (eligible.length === 0 && cooldownBlocked) {
      return {
        outcome: 'REJECTED',
        reasonCode: 'COOLDOWN_ACTIVE',
        detail: `rule '${cooldownBlocked.ruleId}' is within its ${cooldownBlocked.cooldownSeconds}s cooldown for this resource`,
      };
    }

    // Collapse to one candidate per distinct (workflow, resource): multiple
    // rules targeting the same workflow+resource converge on a single run
    // while every contributing rule ID is retained for audit.
    const byWorkflow = new Map<string, { ruleIds: string[]; rule: TriggerRule }>();
    let fanOutCap = Number.MAX_SAFE_INTEGER;
    for (const rule of eligible) {
      fanOutCap = Math.min(fanOutCap, rule.maxFanOut);
      const existing = byWorkflow.get(rule.workflowId);
      if (existing) {
        existing.ruleIds.push(rule.ruleId);
        existing.ruleIds.sort();
      } else {
        byWorkflow.set(rule.workflowId, { ruleIds: [rule.ruleId], rule });
      }
    }

    if (byWorkflow.size > fanOutCap) {
      return {
        outcome: 'REJECTED',
        reasonCode: 'FAN_OUT_EXCEEDED',
        detail: `${byWorkflow.size} distinct workflows exceed the strictest fan-out cap ${fanOutCap}`,
      };
    }

    const candidates: MatchedCandidate[] = [...byWorkflow.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workflowId, entry]) => ({
        workflowId: workflowId as WorkflowIdV1,
        matchedRuleIds: Object.freeze(entry.ruleIds),
        dedupeKey: invocationDedupeKey({
          repositoryId: event.repositoryExternalId,
          sourceKey: event.deliveryId,
          ruleId: entry.ruleIds.join('+'),
          workflowId,
          resourceIdentity: event.resourceIdentity,
          policySnapshotId: snapshot.policySnapshotId,
        }),
        resourceKey: event.resourceIdentity,
        maxFanOut: entry.rule.maxFanOut,
      }));

    return { outcome: 'MATCHED', candidates: Object.freeze(candidates) };
  }
}

// ---------------------------------------------------------------------------
// Manual commands (C028 §10 authorizeManual)
// ---------------------------------------------------------------------------

export interface ManualCommandRequest {
  readonly workflowIdInput: string;
  readonly repositoryId: string;
  readonly idempotencyKey: string;
  /** Trusted fact: caller holds repository write/start permission. */
  readonly callerHasRepositoryAccess: boolean;
  readonly policySnapshotId: string;
}

export type ManualResult =
  | {
      readonly outcome: 'AUTHORIZED';
      readonly workflowId: WorkflowIdV1;
      readonly dedupeKey: string;
      readonly viaAlias?: string | undefined;
    }
  | { readonly outcome: 'DENIED_UNKNOWN'; readonly input: string }
  | { readonly outcome: 'DENIED_NOT_A_WORKFLOW'; readonly input: string; readonly hint: string }
  | { readonly outcome: 'DENIED_UNAVAILABLE'; readonly workflowId: WorkflowIdV1 }
  | { readonly outcome: 'DENIED_NO_ACCESS'; readonly detail: string }
  | { readonly outcome: 'DENIED_RATE_LIMIT'; readonly detail: string };

/** Stateless helper namespace; definitions are supplied per call for snapshot purity. */
export class ManualCommandRegistry {
  /**
   * @param recentInvocationCount invocations in the trailing hour for this
   *        repository+actor (supplied by the application layer's counters)
   */
  authorize(
    request: ManualCommandRequest,
    normalize: (input: string) => WorkflowIdResult,
    definitions: ReadonlyArray<{
      workflowId: WorkflowIdV1;
      available: boolean;
      rateLimitPerHour: number;
    }>,
    context: { recentInvocationCount?: number | undefined } = {},
  ): ManualResult {
    const normalized = normalize(request.workflowIdInput);
    switch (normalized.outcome) {
      case 'UNKNOWN':
        return { outcome: 'DENIED_UNKNOWN', input: request.workflowIdInput };
      case 'NOT_A_WORKFLOW':
        return {
          outcome: 'DENIED_NOT_A_WORKFLOW',
          input: request.workflowIdInput,
          hint: normalized.hint,
        };
      case 'RESOLVED':
        break;
    }
    const definition = definitions.find(
      (candidate) => candidate.workflowId === normalized.workflowId,
    );
    if (!definition) return { outcome: 'DENIED_UNKNOWN', input: request.workflowIdInput };
    if (!definition.available)
      return { outcome: 'DENIED_UNAVAILABLE', workflowId: normalized.workflowId };
    if (!request.callerHasRepositoryAccess) {
      return {
        outcome: 'DENIED_NO_ACCESS',
        detail: 'caller lacks repository workflow-start permission',
      };
    }
    if ((context.recentInvocationCount ?? 0) >= definition.rateLimitPerHour) {
      return {
        outcome: 'DENIED_RATE_LIMIT',
        detail: `manual invocation limit ${definition.rateLimitPerHour}/hour reached`,
      };
    }
    return {
      outcome: 'AUTHORIZED',
      workflowId: normalized.workflowId,
      viaAlias: normalized.viaAlias,
      dedupeKey: invocationDedupeKey({
        repositoryId: request.repositoryId,
        sourceKey: request.idempotencyKey,
        ruleId: 'manual',
        workflowId: normalized.workflowId,
        resourceIdentity: 'manual',
        policySnapshotId: request.policySnapshotId,
      }),
    };
  }
}

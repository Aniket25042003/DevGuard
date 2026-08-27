/**
 * C023 §5/§8 — semantic validation.
 *
 * Cross-field and registry checks on the already schema-valid document:
 * - action arrays must be disjoint (allow/requireApproval/deny)
 * - limits may only exist within global caps
 * - repository owner/name must match the connected repository aggregate
 * - workflow/action/validation references resolve against versioned registries
 *
 * Registry contracts are injected as pure lookups so this stage stays
 * synchronous, deterministic, and independent of C024/C028 persistence.
 */
import type { PolicyValidationReport } from '../schema/diagnostics.js';
import type { POLICY_LIMIT_GLOBAL_CAPS } from '../schema/policy-v1.js';
import type { RepositoryPolicyV1 } from '../schema/policy-v1.js';

export interface RegistryLookups {
  /** Stable action IDs known to C024's tool/action registry. */
  readonly knownActions: ReadonlySet<string>;
  /** Workflow IDs known to C045/C046's versioned registry. */
  readonly knownWorkflows: ReadonlySet<string>;
  /** Validation obligation names known to C029's validator registry. */
  readonly knownObligations: ReadonlySet<string>;
}

export interface SemanticContext {
  readonly expectedOwner?: string | undefined;
  readonly expectedName?: string | undefined;
  readonly registries: RegistryLookups;
}

/** Fail-closed default registries: nothing is referenced-OK by accident. */
export const EMPTY_REGISTRIES: RegistryLookups = Object.freeze({
  knownActions: new Set<string>(),
  knownWorkflows: new Set<string>(),
  knownObligations: new Set<string>(),
});

type GlobalCaps = typeof POLICY_LIMIT_GLOBAL_CAPS;

export function validateSemantics(
  policy: RepositoryPolicyV1,
  report: PolicyValidationReport,
  context: SemanticContext = { registries: EMPTY_REGISTRIES },
): void {
  validateDisjointActions(policy, report);
  validateLimitsWithinCaps(policy, report);
  validateRepositoryMatch(policy, report, context);
  validateReferences(policy, report, context);
}

function validateDisjointActions(policy: RepositoryPolicyV1, report: PolicyValidationReport): void {
  const seen = new Map<string, string>();
  for (const [groupName, actions] of [
    ['allow', policy.actions.allow],
    ['requireApproval', policy.actions.requireApproval],
    ['deny', policy.actions.deny],
  ] as const) {
    for (const action of actions) {
      const existingGroup = seen.get(action);
      if (existingGroup && existingGroup !== groupName) {
        report.add({
          code: 'POLICY_CONFLICT',
          path: `actions.${groupName}`,
          message: `action '${action}' appears in both '${existingGroup}' and '${groupName}'; arrays must be disjoint`,
        });
      }
      if (!existingGroup) seen.set(action, groupName);
    }
  }
}

function validateLimitsWithinCaps(
  policy: RepositoryPolicyV1,
  report: PolicyValidationReport,
): void {
  // The V1 zod schema caps these; double-check defensively against drift.
  const caps: GlobalCaps = { maxFilesChanged: 200, maxIterations: 30, maxRuntimeMinutes: 240 };
  for (const [key, cap] of Object.entries(caps)) {
    const value = policy.limits[key as keyof RepositoryPolicyV1['limits']];
    if (value !== undefined && value > cap) {
      report.add({
        code: 'POLICY_CONFLICT',
        path: `limits.${key}`,
        message: `limit ${value} exceeds global cap ${cap}`,
      });
    }
  }
}

function validateRepositoryMatch(
  policy: RepositoryPolicyV1,
  report: PolicyValidationReport,
  context: SemanticContext,
): void {
  if ((context.expectedOwner === undefined) !== (context.expectedName === undefined)) {
    report.add({ code: 'POLICY_CONFLICT', path: 'repository', message: 'expected repository owner and name must be provided together' });
    return;
  }
  if (context.expectedOwner !== undefined && context.expectedName !== undefined) {
    const matches =
      policy.repository.owner.toLowerCase() === context.expectedOwner.toLowerCase() &&
      policy.repository.name.toLowerCase() === context.expectedName.toLowerCase();
    if (!matches) {
      report.add({
        code: 'POLICY_CONFLICT',
        path: 'repository',
        message:
          `policy targets ${policy.repository.owner}/${policy.repository.name}, ` +
          `but is bound to ${context.expectedOwner}/${context.expectedName}; retargeting is forbidden`,
      });
    }
  }
}

/** Trigger kinds fixed by C004's shared workflow contract. */
const TRIGGER_KINDS = new Set(['manual', 'webhook', 'api']);

function validateReferences(
  policy: RepositoryPolicyV1,
  report: PolicyValidationReport,
  context: SemanticContext,
): void {
  for (const action of [
    ...policy.actions.allow,
    ...policy.actions.requireApproval,
    ...policy.actions.deny,
  ]) {
    if (!context.registries.knownActions.has(action)) {
      report.add({
        code: 'POLICY_REFERENCE_UNKNOWN',
        path: 'actions',
        message: `unknown action '${action}'`,
      });
    }
  }
  for (const triggerKind of Object.keys(policy.triggers)) {
    if (!TRIGGER_KINDS.has(triggerKind)) {
      report.add({
        code: 'POLICY_REFERENCE_UNKNOWN',
        path: 'triggers',
        message: `unknown trigger kind '${triggerKind}' (expected manual|webhook|api)`,
      });
    }
    for (const workflow of policy.triggers[triggerKind] ?? []) {
      if (!context.registries.knownWorkflows.has(workflow)) {
        report.add({
          code: 'POLICY_REFERENCE_UNKNOWN',
          path: `triggers.${triggerKind}`,
          message: `unknown workflow id '${workflow}'`,
        });
      }
    }
  }
  for (const command of policy.manualCommands) {
    if (!context.registries.knownWorkflows.has(command)) {
      report.add({
        code: 'POLICY_REFERENCE_UNKNOWN',
        path: 'manualCommands',
        message: `unknown workflow id '${command}'`,
      });
    }
  }
  for (const obligation of policy.validation.obligations) {
    if (!context.registries.knownObligations.has(obligation)) {
      report.add({
        code: 'POLICY_REFERENCE_UNKNOWN',
        path: 'validation.obligations',
        message: `unknown validation obligation '${obligation}'`,
      });
    }
  }
}

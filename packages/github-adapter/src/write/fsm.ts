/**
 * C020 §9 — exhaustive mutation state machine.
 *
 * `authorized → executing → applied|outcome_unknown|conflicted|failed`;
 * `outcome_unknown → reconciling → applied|not_applied|conflicted|manual_review`;
 * `not_applied → executing` only for a bounded retry. Every non-listed
 * (from, trigger) pair is rejected. An uncertain provider outcome is never
 * mapped to a blind failure; it must exit via reconciliation.
 */
import { MUTATION_STATUSES, MUTATION_TERMINAL_STATUSES, type MutationStatus } from './contracts.js';

export type MutationTrigger =
  | 'begin' // authorized -> executing
  | 'applied'
  | 'unknown'
  | 'conflict'
  | 'fail'
  | 'begin_reconcile' // outcome_unknown -> reconciling
  | 'reconciled_applied'
  | 'reconciled_not_applied'
  | 'reconciled_conflicted'
  | 'manual'
  | 'retry'; // not_applied -> executing

const EDGES: Readonly<
  Record<MutationTrigger, ReadonlyArray<{ from: MutationStatus; to: MutationStatus }>>
> = {
  begin: [{ from: 'authorized', to: 'executing' }],
  applied: [
    { from: 'executing', to: 'applied' },
    { from: 'reconciling', to: 'applied' },
  ],
  unknown: [{ from: 'executing', to: 'outcome_unknown' }],
  conflict: [
    { from: 'executing', to: 'conflicted' },
    { from: 'reconciling', to: 'conflicted' },
  ],
  fail: [{ from: 'executing', to: 'failed' }],
  begin_reconcile: [{ from: 'outcome_unknown', to: 'reconciling' }],
  reconciled_applied: [{ from: 'reconciling', to: 'applied' }],
  reconciled_not_applied: [{ from: 'reconciling', to: 'not_applied' }],
  reconciled_conflicted: [{ from: 'reconciling', to: 'conflicted' }],
  manual: [{ from: 'reconciling', to: 'manual_review' }],
  retry: [{ from: 'not_applied', to: 'executing' }],
};

function assertTable(): void {
  for (const edges of Object.values(EDGES)) {
    for (const edge of edges) {
      if (!(MUTATION_STATUSES as readonly string[]).includes(edge.from)) {
        throw new TypeError(`unknown state ${edge.from}`);
      }
      if (!(MUTATION_STATUSES as readonly string[]).includes(edge.to)) {
        throw new TypeError(`unknown state ${edge.to}`);
      }
    }
  }
}
assertTable();

export type TransitionVerdict =
  | { readonly allowed: true; readonly from: MutationStatus; readonly to: MutationStatus }
  | {
      readonly allowed: false;
      readonly code: 'GITHUB_MUTATION_ILLEGAL_TRANSITION';
      readonly detail: string;
    };

export function resolveMutationEdge(
  from: MutationStatus,
  trigger: MutationTrigger,
): TransitionVerdict {
  if (MUTATION_TERMINAL_STATUSES.includes(from) && trigger !== 'retry') {
    return {
      allowed: false,
      code: 'GITHUB_MUTATION_ILLEGAL_TRANSITION',
      detail: `'${from}' is terminal`,
    };
  }
  const match = (EDGES[trigger] ?? []).find((e) => e.from === from);
  if (match === undefined) {
    return {
      allowed: false,
      code: 'GITHUB_MUTATION_ILLEGAL_TRANSITION',
      detail: `trigger '${trigger}' cannot fire from '${from}'`,
    };
  }
  return { allowed: true, from: match.from, to: match.to };
}

export function isTerminalMutation(status: MutationStatus): boolean {
  return MUTATION_TERMINAL_STATUSES.includes(status);
}

export function allMutationPairs(): ReadonlyArray<{
  from: MutationStatus;
  trigger: MutationTrigger;
}> {
  const out: Array<{ from: MutationStatus; trigger: MutationTrigger }> = [];
  for (const from of MUTATION_STATUSES) {
    for (const trigger of Object.keys(EDGES) as MutationTrigger[]) out.push({ from, trigger });
  }
  return out;
}

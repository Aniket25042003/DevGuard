/**
 * C021 §9 — PR mutation + merge FSMs.
 *
 * General mutation: `authorized → executing → applied|outcome_unknown|conflicted|failed`;
 * unknown → reconciling. Merge additionally requires
 * `approved → revalidating → executing → verifying → applied|stale|blocked|unknown|failed`.
 * Any head/base/policy change after approval yields stale/blocked, not execution.
 */
export const PR_MUTATION_STATUSES = [
  'authorized',
  'executing',
  'applied',
  'outcome_unknown',
  'conflicted',
  'failed',
  'reconciling',
  'not_applied',
] as const;
export type PrMutationStatus = (typeof PR_MUTATION_STATUSES)[number];

export const PR_MERGE_STATUSES = [
  'approved',
  'revalidating',
  'executing',
  'verifying',
  'applied',
  'stale',
  'blocked',
  'outcome_unknown',
  'failed',
] as const;
export type PrMergeStatus = (typeof PR_MERGE_STATUSES)[number];

const MUTATION_EDGES: Readonly<
  Record<string, ReadonlyArray<[PrMutationStatus, PrMutationStatus]>>
> = {
  begin: [['authorized', 'executing']],
  applied: [
    ['executing', 'applied'],
    ['reconciling', 'applied'],
  ],
  unknown: [['executing', 'outcome_unknown']],
  conflict: [
    ['executing', 'conflicted'],
    ['reconciling', 'conflicted'],
  ],
  fail: [['executing', 'failed']],
  begin_reconcile: [['outcome_unknown', 'reconciling']],
  reconciled_applied: [['reconciling', 'applied']],
  reconciled_not_applied: [['reconciling', 'not_applied']],
  reconciled_conflicted: [['reconciling', 'conflicted']],
};

const MERGE_EDGES: Readonly<Record<string, ReadonlyArray<[PrMergeStatus, PrMergeStatus]>>> = {
  revalidate: [['approved', 'revalidating']],
  execute: [['revalidating', 'executing']],
  verify: [['executing', 'verifying']],
  applied: [['verifying', 'applied']],
  stale: [
    ['approved', 'stale'],
    ['revalidating', 'stale'],
  ],
  blocked: [
    ['approved', 'blocked'],
    ['verifying', 'blocked'],
  ],
  unknown: [
    ['executing', 'outcome_unknown'],
    ['verifying', 'outcome_unknown'],
  ],
  fail: [
    ['revalidating', 'failed'],
    ['executing', 'failed'],
  ],
};

export type PrTransitionVerdict =
  | { readonly allowed: true; readonly to: string }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

export function resolvePrMutationEdge(
  from: PrMutationStatus,
  trigger: string,
): PrTransitionVerdict {
  const match = (MUTATION_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? {
        allowed: false,
        code: 'PR_MUTATION_ILLEGAL_TRANSITION',
        detail: `'${trigger}' from '${from}'`,
      }
    : { allowed: true, to: match[1] };
}

export function resolvePrMergeEdge(from: PrMergeStatus, trigger: string): PrTransitionVerdict {
  const match = (MERGE_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? { allowed: false, code: 'PR_MERGE_ILLEGAL_TRANSITION', detail: `'${trigger}' from '${from}'` }
    : { allowed: true, to: match[1] };
}

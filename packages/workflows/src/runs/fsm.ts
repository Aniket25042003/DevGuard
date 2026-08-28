/**
 * C046 §9 — run/step state machines.
 *
 * Run: `PENDING → PROVISIONING → RUNNING → SUCCEEDED|FAILED|CANCELLED` with
 * `RUNNING ↔ PAUSED|WAITING_APPROVAL` and `→ RECONCILING` from any nonterminal.
 * Step: `PENDING → PROVISIONING → RUNNING → SUCCEEDED|FAILED|CANCELLED` (+ pause).
 * Every non-listed pair is rejected; terminal states never transition.
 */
import type { RunState, StepState } from './contracts.js';

export type RunTrigger =
  | 'begin'
  | 'provisioned'
  | 'run'
  | 'pause'
  | 'resume'
  | 'await_approval'
  | 'approval_resolved'
  | 'succeed'
  | 'fail'
  | 'cancel'
  | 'reconcile';

export type RunVerdict =
  | { readonly allowed: true; readonly to: RunState }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

const RUN_EDGES: Readonly<Record<RunTrigger, ReadonlyArray<[RunState, RunState]>>> = {
  begin: [['PENDING', 'PROVISIONING']],
  provisioned: [['PROVISIONING', 'RUNNING']],
  run: [['PENDING', 'RUNNING']],
  pause: [['RUNNING', 'PAUSED']],
  resume: [['PAUSED', 'RUNNING']],
  await_approval: [['RUNNING', 'WAITING_APPROVAL']],
  approval_resolved: [['WAITING_APPROVAL', 'RUNNING']],
  succeed: [['RUNNING', 'SUCCEEDED']],
  fail: [
    ['PENDING', 'FAILED'],
    ['PROVISIONING', 'FAILED'],
    ['RUNNING', 'FAILED'],
    ['RECONCILING', 'FAILED'],
  ],
  cancel: [
    ['PENDING', 'CANCELLED'],
    ['PROVISIONING', 'CANCELLED'],
    ['RUNNING', 'CANCELLED'],
    ['PAUSED', 'CANCELLED'],
    ['WAITING_APPROVAL', 'CANCELLED'],
  ],
  reconcile: [
    ['PENDING', 'RECONCILING'],
    ['PROVISIONING', 'RECONCILING'],
    ['RUNNING', 'RECONCILING'],
    ['PAUSED', 'RECONCILING'],
    ['WAITING_APPROVAL', 'RECONCILING'],
  ],
};

const RUN_TERMINALS: readonly RunState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export function resolveRunEdge(from: RunState, trigger: RunTrigger): RunVerdict {
  if (RUN_TERMINALS.includes(from))
    return { allowed: false, code: 'RUN_ILLEGAL_TRANSITION', detail: `terminal '${from}'` };
  const match = (RUN_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? { allowed: false, code: 'RUN_ILLEGAL_TRANSITION', detail: `'${trigger}' from '${from}'` }
    : { allowed: true, to: match[1] };
}

export type StepTrigger =
  'begin' | 'provisioned' | 'run' | 'pause' | 'resume' | 'succeed' | 'fail' | 'cancel';

export type StepVerdict =
  | { readonly allowed: true; readonly to: StepState }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

const STEP_EDGES: Readonly<Record<StepTrigger, ReadonlyArray<[StepState, StepState]>>> = {
  begin: [['PENDING', 'PROVISIONING']],
  provisioned: [['PROVISIONING', 'RUNNING']],
  run: [['PENDING', 'RUNNING']],
  pause: [['RUNNING', 'PAUSED']],
  resume: [['PAUSED', 'RUNNING']],
  succeed: [['RUNNING', 'SUCCEEDED']],
  fail: [
    ['PROVISIONING', 'FAILED'],
    ['RUNNING', 'FAILED'],
    ['PAUSED', 'FAILED'],
  ],
  cancel: [
    ['PENDING', 'CANCELLED'],
    ['PROVISIONING', 'CANCELLED'],
    ['RUNNING', 'CANCELLED'],
    ['PAUSED', 'CANCELLED'],
  ],
};

const STEP_TERMINALS: readonly StepState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export function resolveStepEdge(from: StepState, trigger: StepTrigger): StepVerdict {
  if (STEP_TERMINALS.includes(from))
    return { allowed: false, code: 'STEP_ILLEGAL_TRANSITION', detail: `terminal '${from}'` };
  const match = (STEP_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? { allowed: false, code: 'STEP_ILLEGAL_TRANSITION', detail: `'${trigger}' from '${from}'` }
    : { allowed: true, to: match[1] };
}

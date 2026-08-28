/**
 * C042 §9 — exhaustive sandbox command FSM.
 *
 * `PROPOSED → AUTHORIZED → QUEUED → STARTING → RUNNING → SUCCEEDED|FAILED|
 * TIMING_OUT|CANCELLING|UNKNOWN`; `TIMING_OUT|CANCELLING → TERMINATING →
 * TIMED_OUT|CANCELLED|TERMINATION_FAILED`; `UNKNOWN → RECONCILING → terminal or
 * QUARANTINED`. Terminal states never transition.
 */
import type { CommandState } from './contracts.js';

export type CommandTrigger =
  | 'authorize'
  | 'queue'
  | 'start'
  | 'running'
  | 'succeed'
  | 'fail'
  | 'deadline' // RUNNING -> TIMING_OUT
  | 'cancel_request' // RUNNING -> CANCELLING
  | 'terminate' // TIMING_OUT|CANCELLING -> TERMINATING
  | 'timed_out'
  | 'cancelled'
  | 'termination_failed'
  | 'unknown' // RUNNING|TERMINATING -> UNKNOWN
  | 'reconcile' // UNKNOWN -> RECONCILING
  | 'quarantine' // RECONCILING -> QUARANTINED
  | 'resolved'; // RECONCILING -> SUCCEEDED|FAILED

export type CommandVerdict =
  | { readonly allowed: true; readonly from: CommandState; readonly to: CommandState }
  | {
      readonly allowed: false;
      readonly code: 'COMMAND_ILLEGAL_TRANSITION';
      readonly detail: string;
    };

const TERMINALS: readonly CommandState[] = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'TERMINATION_FAILED',
  'QUARANTINED',
];

const EDGES: Readonly<Record<CommandTrigger, ReadonlyArray<[CommandState, CommandState]>>> = {
  authorize: [['PROPOSED', 'AUTHORIZED']],
  queue: [['AUTHORIZED', 'QUEUED']],
  start: [['QUEUED', 'STARTING']],
  running: [['STARTING', 'RUNNING']],
  succeed: [['RUNNING', 'SUCCEEDED']],
  fail: [
    ['RUNNING', 'FAILED'],
    ['STARTING', 'FAILED'],
  ],
  deadline: [['RUNNING', 'TIMING_OUT']],
  cancel_request: [['RUNNING', 'CANCELLING']],
  terminate: [
    ['TIMING_OUT', 'TERMINATING'],
    ['CANCELLING', 'TERMINATING'],
  ],
  timed_out: [['TERMINATING', 'TIMED_OUT']],
  cancelled: [['TERMINATING', 'CANCELLED']],
  termination_failed: [['TERMINATING', 'TERMINATION_FAILED']],
  unknown: [
    ['RUNNING', 'UNKNOWN'],
    ['STARTING', 'UNKNOWN'],
    ['TERMINATING', 'UNKNOWN'],
  ],
  reconcile: [['UNKNOWN', 'RECONCILING']],
  quarantine: [['RECONCILING', 'QUARANTINED']],
  resolved: [['RECONCILING', 'SUCCEEDED']],
};

export function resolveCommandEdge(from: CommandState, trigger: CommandTrigger): CommandVerdict {
  if (TERMINALS.includes(from)) {
    return { allowed: false, code: 'COMMAND_ILLEGAL_TRANSITION', detail: `terminal '${from}'` };
  }
  const match = (EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? { allowed: false, code: 'COMMAND_ILLEGAL_TRANSITION', detail: `'${trigger}' from '${from}'` }
    : { allowed: true, from: match[0], to: match[1] };
}

export function isTerminalCommand(state: CommandState): boolean {
  return TERMINALS.includes(state);
}

/**
 * C037 §9 — exhaustive session/turn FSMs.
 *
 * Session: `CREATING → READY → TURN_ACTIVE ↔ READY`;
 * `READY|TURN_ACTIVE → CANCELLING → CANCELLED`; any nonterminal → `RECONCILING`
 * (recoverable back to prior); terminals `COMPLETED|CANCELLED|FAILED` immutable.
 * Turn: `REQUESTED → SUBMITTING → RUNNING → PAUSED|SUCCEEDED|FAILED|CANCELLED`;
 * `PAUSED → RUNNING` only via a required-action result; `SUBMITTING|RUNNING|PAUSED
 * → RECONCILING`. Every non-listed pair is rejected.
 */
import type { AgentSessionStatus, AgentTurnStatus } from './contracts.js';

export type SessionTrigger =
  | 'begin' // CREATING
  | 'ready'
  | 'turn_active'
  | 'idle' // TURN_ACTIVE -> READY
  | 'cancel'
  | 'cancelled'
  | 'complete'
  | 'fail'
  | 'reconcile'
  | 'restore';

export type SessionVerdict =
  | { readonly allowed: true; readonly from: AgentSessionStatus; readonly to: AgentSessionStatus }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

const SESSION_EDGES: Readonly<
  Record<SessionTrigger, ReadonlyArray<[AgentSessionStatus, AgentSessionStatus]>>
> = {
  begin: [['CREATING', 'READY']],
  ready: [['CREATING', 'READY']],
  turn_active: [['READY', 'TURN_ACTIVE']],
  idle: [['TURN_ACTIVE', 'READY']],
  cancel: [
    ['READY', 'CANCELLING'],
    ['TURN_ACTIVE', 'CANCELLING'],
  ],
  cancelled: [['CANCELLING', 'CANCELLED']],
  complete: [
    ['READY', 'COMPLETED'],
    ['TURN_ACTIVE', 'COMPLETED'],
  ],
  fail: [
    ['CREATING', 'FAILED'],
    ['CANCELLING', 'FAILED'],
    ['RECONCILING', 'FAILED'],
  ],
  reconcile: [
    ['CREATING', 'RECONCILING'],
    ['READY', 'RECONCILING'],
    ['TURN_ACTIVE', 'RECONCILING'],
    ['CANCELLING', 'RECONCILING'],
    ['SUBMITTING', 'RECONCILING'],
    ['RUNNING', 'RECONCILING'],
  ],
  restore: [['RECONCILING', 'READY']],
};

export function resolveSessionEdge(
  from: AgentSessionStatus,
  trigger: SessionTrigger,
): SessionVerdict {
  const match = (SESSION_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? {
        allowed: false,
        code: 'AGENT_SESSION_ILLEGAL_TRANSITION',
        detail: `'${trigger}' from '${from}'`,
      }
    : { allowed: true, from: match[0], to: match[1] };
}

export type TurnTrigger =
  | 'submit' // REQUESTED -> SUBMITTING
  | 'started' // SUBMITTING -> RUNNING
  | 'pause' // RUNNING -> PAUSED
  | 'resume' // PAUSED -> RUNNING (required-action result)
  | 'succeed' // RUNNING -> SUCCEEDED
  | 'fail' // SUBMITTING|RUNNING|PAUSED -> FAILED
  | 'cancel' // requests -> CANCELLED
  | 'reconcile' // SUBMITTING|RUNNING|PAUSED -> RECONCILING
  | 'restore'; // RECONCILING -> RUNNING

export type TurnVerdict =
  | { readonly allowed: true; readonly from: AgentTurnStatus; readonly to: AgentTurnStatus }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

const TURN_EDGES: Readonly<Record<TurnTrigger, ReadonlyArray<[AgentTurnStatus, AgentTurnStatus]>>> =
  {
    submit: [['REQUESTED', 'SUBMITTING']],
    started: [['SUBMITTING', 'RUNNING']],
    pause: [['RUNNING', 'PAUSED']],
    resume: [['PAUSED', 'RUNNING']],
    succeed: [['RUNNING', 'SUCCEEDED']],
    fail: [
      ['SUBMITTING', 'FAILED'],
      ['RUNNING', 'FAILED'],
      ['PAUSED', 'FAILED'],
      ['RECONCILING', 'FAILED'],
    ],
    cancel: [
      ['REQUESTED', 'CANCELLED'],
      ['SUBMITTING', 'CANCELLED'],
      ['RUNNING', 'CANCELLED'],
      ['PAUSED', 'CANCELLED'],
    ],
    reconcile: [
      ['SUBMITTING', 'RECONCILING'],
      ['RUNNING', 'RECONCILING'],
      ['PAUSED', 'RECONCILING'],
    ],
    restore: [['RECONCILING', 'RUNNING']],
  };

export function resolveTurnEdge(from: AgentTurnStatus, trigger: TurnTrigger): TurnVerdict {
  const match = (TURN_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? {
        allowed: false,
        code: 'AGENT_TURN_ILLEGAL_TRANSITION',
        detail: `'${trigger}' from '${from}'`,
      }
    : { allowed: true, from: match[0], to: match[1] };
}

export function isTerminalSession(status: AgentSessionStatus): boolean {
  return status === 'CANCELLED' || status === 'COMPLETED' || status === 'FAILED';
}
export function isTerminalTurn(status: AgentTurnStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

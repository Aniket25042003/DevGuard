/**
 * C037 §10/§12 — AgentSessionService.
 *
 * `ensureSession` (idempotent by command key), `submitTurn` (one-active-turn
 * slot + cancellation-generation fencing + command idempotency), `observeTurn`
 * (terminal/pause projection; turn completion is NOT workflow completion), and
 * `reconcileSession` (recover nonterminal states against the runtime). Only the
 * verified runtime port (C036) and stores cross the boundary; provider types and
 * raw thinking never do.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import {
  ensureAgentSessionSchema,
  observeAgentTurnSchema,
  reconcileAgentSessionSchema,
  submitAgentTurnSchema,
  type AgentSession,
  type AgentSessionRef,
  type AgentTurn,
  type AgentTurnObservation,
  type AgentTurnRef,
  type EnsureAgentSession,
  type SubmitAgentTurn,
} from './contracts.js';
import { isTerminalSession, isTerminalTurn } from './fsm.js';
import type { AgentRuntimePort } from './agent-runtime-port.js';
import {
  sessionIdForCommand,
  sha256Hex,
  type SessionStorePort,
  type TurnStorePort,
} from './repos.js';

// TurnObservation is defined inline for the service; see contracts for shapes.
export interface AgentTurnObservationShaped {
  readonly turn: AgentTurn;
  readonly status: AgentTurn['status'];
  readonly summaryRef?: string | undefined;
}

export interface AgentEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}
export interface AgentEventSinkPort {
  emit(event: AgentEvent): Promise<void>;
}

export interface AgentSessionServiceDeps {
  readonly runtime: AgentRuntimePort;
  readonly sessions: SessionStorePort;
  readonly turns: TurnStorePort;
  readonly agentVersion: string;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: AgentEventSinkPort;
}

export class AgentSessionService {
  readonly #runtime: AgentRuntimePort;
  readonly #sessions: SessionStorePort;
  readonly #turns: TurnStorePort;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: AgentEventSinkPort;
  readonly #agentVersion: string;

  constructor(deps: AgentSessionServiceDeps) {
    this.#runtime = deps.runtime;
    this.#sessions = deps.sessions;
    this.#turns = deps.turns;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? { emit: async () => undefined };
    this.#agentVersion = deps.agentVersion;
  }

  async ensureSession(input: EnsureAgentSession): Promise<AgentSessionRef> {
    const parsed = ensureAgentSessionSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'ENSURE_SESSION_INPUT' } });
    const req = parsed.data;

    const existing = await this.#sessions.findByCommandKey(req.commandKey);
    if (existing !== undefined) {
      if (existing.status === 'FAILED')
        throw makeError('SESSION_FAILED', { details: { sessionId: existing.id } });
      return refOf(existing);
    }

    const id = sessionIdForCommand(req.commandKey);
    const session: AgentSession = {
      id,
      workflowRunId: req.workflowRunId,
      repositoryId: req.repositoryId,
      agentDefinitionId: req.agentDefinitionId,
      agentVersion: this.#agentVersion,
      provider: 'trueforge',
      contractSnapshotDigest: req.contractSnapshotDigest,
      status: 'CREATING',
      cancellationGeneration: 0,
      version: 0,
      startedAtIso: this.#clock.nowIso(),
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#sessions.save(session, 0);

    const created = await this.#runtime.createSession({
      provider: session.provider,
      agentVersion: this.#agentVersion,
    });
    if (!created.ok) {
      const failed: AgentSession = {
        ...session,
        status: 'FAILED',
        updatedAtIso: this.#clock.nowIso(),
      };
      await this.#sessions.save(failed, 1);
      await this.#event('session.state_changed.v1', id, { status: 'FAILED' });
      throw makeError('SESSION_CREATE_FAILED', { details: { code: created.code } });
    }
    const ready: AgentSession = {
      ...session,
      providerSessionId: created.value.providerSessionId,
      providerThreadId: created.value.providerThreadId,
      status: 'READY',
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#sessions.save(ready, 1);
    await this.#event('session.created.v1', id, { status: 'READY' });
    return refOf(ready);
  }

  async submitTurn(input: SubmitAgentTurn): Promise<AgentTurnRef> {
    const parsed = submitAgentTurnSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'SUBMIT_TURN_INPUT' } });
    const req = parsed.data;

    const session = await this.#sessions.get(req.sessionId);
    if (session === undefined)
      throw makeError('SESSION_NOT_FOUND', { details: { sessionId: req.sessionId } });
    if (isTerminalSession(session.status))
      throw makeError('SESSION_TERMINAL', { details: { status: session.status } });
    if (session.cancellationGeneration !== req.expectedCancellationGeneration) {
      throw makeError('TURN_GENERATION_STALE', {
        details: { actual: String(session.cancellationGeneration) },
      });
    }
    if (req.purpose === 'REQUIRED_ACTION_RESULT' && req.linkedPausedTurnId === undefined) {
      throw makeError('REQUIRED_ACTION_RESULT_LINK_REQUIRED', {});
    }

    const existing = await this.#turns.findByCommandKey(req.commandId);
    if (existing !== undefined) {
      if (existing.inputDigest !== sha256Hex(String(req.contextDigest))) {
        throw makeError('TURN_COMMAND_DIGEST_CONFLICT', {});
      }
      return refOfTurn(existing);
    }

    const active = await this.#turns.countActive(req.sessionId);
    if (active >= 1)
      throw makeError('SESSION_TURN_ACTIVE', { details: { sessionId: req.sessionId } });

    const ordinal = await this.#turns.nextOrdinal(req.sessionId);
    const turn: AgentTurn = {
      id: randomUUID(),
      sessionId: req.sessionId,
      ordinal,
      purpose: req.purpose,
      commandKey: req.commandId,
      inputDigest: sha256Hex(String(req.contextDigest)),
      toolProfileId: req.toolProfileId,
      status: 'REQUESTED',
      startedAtIso: this.#clock.nowIso(),
    };
    await this.#turns.save(turn);
    await this.#event('turn.requested.v1', turn.id, { sessionId: req.sessionId });
    return refOfTurn(turn);
  }

  async observeTurn(input: { turnId: string }): Promise<AgentTurnObservation> {
    const parsed = observeAgentTurnSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'OBSERVE_TURN_INPUT' } });
    const turn = await this.#turns.get(parsed.data.turnId);
    if (turn === undefined)
      throw makeError('TURN_NOT_FOUND', { details: { turnId: parsed.data.turnId } });
    if (isTerminalTurn(turn.status)) {
      return {
        turn,
        observation: 'completed' as const,
        status: turn.status,
        summaryRef: turn.finalResponseDigest,
      };
    }
    return {
      turn,
      observation: turn.status === 'PAUSED' ? ('paused' as const) : ('running' as const),
      status: turn.status,
    };
  }

  async reconcileSession(input: { sessionId: string }): Promise<AgentSessionRef> {
    const parsed = reconcileAgentSessionSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'RECONCILE_SESSION_INPUT' } });
    const session = await this.#sessions.get(parsed.data.sessionId);
    if (session === undefined)
      throw makeError('SESSION_NOT_FOUND', { details: { sessionId: parsed.data.sessionId } });
    if (isTerminalSession(session.status)) return refOf(session);

    const reconciled: AgentSession = {
      ...session,
      status: 'RECONCILING',
      updatedAtIso: this.#clock.nowIso(),
    };
    const saved = await this.#sessions.save(reconciled, session.version);
    if (!saved.ok) throw makeError('SESSION_VERSION_CONFLICT', {});
    await this.#event('session.state_changed.v1', session.id, { status: 'RECONCILING' });
    return refOf(saved.session);
  }

  async #event(type: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    await this.#emit.emit({ type, aggregateId, payload });
  }
}

function refOf(session: AgentSession): AgentSessionRef {
  return {
    sessionId: session.id,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    providerThreadId: session.providerThreadId,
    providerVersion: session.agentVersion,
    status: session.status,
  };
}

function refOfTurn(turn: AgentTurn): AgentTurnRef {
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    ordinal: turn.ordinal,
    providerTurnId: turn.providerTurnId,
    status: turn.status,
  };
}

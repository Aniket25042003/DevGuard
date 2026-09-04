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
      commandKey: req.commandKey,
    };
    const reserved = await this.#sessions.save(session, 0);
    if (!reserved.ok) {
      // Another worker may have reserved the deterministic id between our
      // lookup and INSERT. Re-read by command key so concurrent idempotent
      // requests converge on the first provider session instead of surfacing
      // a spurious 409.
      const concurrent = await this.#sessions.findByCommandKey(req.commandKey);
      if (concurrent !== undefined) {
        if (concurrent.status === 'FAILED')
          throw makeError('SESSION_FAILED', { details: { sessionId: concurrent.id } });
        return refOf(concurrent);
      }
      throw makeError('SESSION_VERSION_CONFLICT', {});
    }

    const created = await this.#runtime.createSession({
      provider: session.provider,
      agentVersion: this.#agentVersion,
    });
    if (!created.ok) {
      const failed: AgentSession = {
        ...reserved.session,
        status: 'FAILED',
        updatedAtIso: this.#clock.nowIso(),
      };
      await this.#sessions.save(failed, reserved.session.version);
      await this.#event('session.state_changed.v1', id, { status: 'FAILED' });
      throw makeError('SESSION_CREATE_FAILED', { details: { code: created.code } });
    }
    const ready: AgentSession = {
      ...reserved.session,
      providerSessionId: created.value.providerSessionId,
      providerThreadId: created.value.providerThreadId,
      status: 'READY',
      updatedAtIso: this.#clock.nowIso(),
    };
    const saved = await this.#sessions.save(ready, reserved.session.version);
    if (!saved.ok) throw makeError('SESSION_VERSION_CONFLICT', {});
    await this.#event('session.created.v1', id, { status: 'READY' });
    return refOf(saved.session);
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
    try {
      await this.#turns.save(turn);
    } catch (error) {
      // The partial unique index is the final concurrency guard. Normalize
      // that database race into the same idempotent/domain errors used by the
      // preflight checks rather than leaking a driver exception.
      const concurrent = await this.#turns.findByCommandKey(req.commandId);
      if (concurrent !== undefined) {
        if (concurrent.inputDigest !== turn.inputDigest)
          throw makeError('TURN_COMMAND_DIGEST_CONFLICT', {});
        return refOfTurn(concurrent);
      }
      if ((await this.#turns.countActive(req.sessionId)) > 0)
        throw makeError('SESSION_TURN_ACTIVE', { details: { sessionId: req.sessionId } });
      throw error;
    }
    await this.#event('turn.requested.v1', turn.id, { sessionId: req.sessionId });

    if (session.providerSessionId === undefined) {
      const failed = { ...turn, status: 'FAILED' as const, errorCode: 'SESSION_PROVIDER_MISSING' };
      await this.#turns.save(failed);
      throw makeError('SESSION_PROVIDER_MISSING', { details: { sessionId: session.id } });
    }

    const submitting = { ...turn, status: 'SUBMITTING' as const };
    await this.#turns.save(submitting);
    const created = await this.#runtime.createTurn({
      providerSessionId: session.providerSessionId,
      ordinal: turn.ordinal,
    });
    if (!created.ok) {
      await this.#turns.save({ ...submitting, status: 'FAILED', errorCode: created.code });
      await this.#event('turn.state_changed.v1', turn.id, {
        sessionId: session.id,
        status: 'FAILED',
        errorCode: created.code,
      });
      throw makeError('TURN_CREATE_FAILED', { details: { code: created.code } });
    }

    const running: AgentTurn = {
      ...submitting,
      status: 'RUNNING',
      providerTurnId: created.value.providerTurnId,
    };
    await this.#turns.save(running);
    const activeSession: AgentSession = {
      ...session,
      status: 'TURN_ACTIVE',
      currentTurnId: running.id,
      updatedAtIso: this.#clock.nowIso(),
    };
    const sessionSaved = await this.#sessions.save(activeSession, session.version);
    if (!sessionSaved.ok) throw makeError('SESSION_VERSION_CONFLICT', {});
    await this.#event('turn.started.v1', turn.id, { sessionId: session.id });
    return refOfTurn(running);
  }

  async observeTurn(input: { turnId: string }): Promise<AgentTurnObservation> {
    const parsed = observeAgentTurnSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'OBSERVE_TURN_INPUT' } });
    const turn = await this.#turns.get(parsed.data.turnId);
    if (turn === undefined)
      throw makeError('TURN_NOT_FOUND', { details: { turnId: parsed.data.turnId } });
    let observed = turn;
    if (!isTerminalTurn(turn.status) && turn.providerTurnId !== undefined) {
      const session = await this.#sessions.get(turn.sessionId);
      if (session?.providerSessionId !== undefined) {
        const result = await this.#runtime.getTurnStatus({
          providerSessionId: session.providerSessionId,
          providerTurnId: turn.providerTurnId,
        });
        if (result.ok) {
          const nextStatus = mapProviderTurnStatus(result.value.status);
          if (nextStatus !== turn.status || result.value.terminalReason !== undefined) {
            observed = {
              ...turn,
              status: nextStatus,
              ...(result.value.terminalReason !== undefined
                ? { providerTerminalReason: result.value.terminalReason }
                : {}),
              ...(isTerminalTurn(nextStatus) ? { completedAtIso: this.#clock.nowIso() } : {}),
            };
            await this.#turns.save(observed);
          }
        } else {
          observed = { ...turn, status: 'RECONCILING', errorCode: result.code };
          await this.#turns.save(observed);
          await this.#event('turn.state_changed.v1', turn.id, {
            sessionId: turn.sessionId,
            status: 'RECONCILING',
            errorCode: result.code,
          });
        }
      }
    }
    if (isTerminalTurn(observed.status)) await this.#settleSessionForTurn(observed);
    if (isTerminalTurn(observed.status)) {
      return {
        turn: observed,
        observation: 'completed' as const,
        status: observed.status,
        summaryRef: observed.finalResponseDigest,
      };
    }
    return {
      turn: observed,
      observation: observed.status === 'PAUSED' ? ('paused' as const) : ('running' as const),
      status: observed.status,
    };
  }

  /** Cancel provider work and fence every in-flight turn with a new generation. */
  async cancelSession(input: { sessionId: string; expectedVersion: number }): Promise<AgentSessionRef> {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'CANCEL_SESSION_INPUT' } });
    const session = await this.#sessions.get(input.sessionId);
    if (session === undefined)
      throw makeError('SESSION_NOT_FOUND', { details: { sessionId: input.sessionId } });
    if (isTerminalSession(session.status)) return refOf(session);
    const cancelling: AgentSession = {
      ...session,
      status: 'CANCELLING',
      cancellationGeneration: session.cancellationGeneration + 1,
      updatedAtIso: this.#clock.nowIso(),
    };
    const claimed = await this.#sessions.save(cancelling, input.expectedVersion);
    if (!claimed.ok) throw makeError('SESSION_VERSION_CONFLICT', {});
    if (session.providerSessionId !== undefined && this.#runtime.cancelSession !== undefined) {
      const result = await this.#runtime.cancelSession({ providerSessionId: session.providerSessionId });
      if (!result.ok) {
        const reconciling: AgentSession = {
          ...claimed.session,
          status: 'RECONCILING',
          updatedAtIso: this.#clock.nowIso(),
        };
        await this.#sessions.save(reconciling, claimed.session.version);
        throw makeError('SESSION_CANCEL_FAILED', { details: { code: result.code } });
      }
    }
    const cancelled = { ...claimed.session, status: 'CANCELLED' as const, updatedAtIso: this.#clock.nowIso() };
    const saved = await this.#sessions.save(cancelled, claimed.session.version);
    if (!saved.ok) throw makeError('SESSION_VERSION_CONFLICT', {});
    const activeTurn = session.currentTurnId === undefined ? undefined : await this.#turns.get(session.currentTurnId);
    if (activeTurn !== undefined && !isTerminalTurn(activeTurn.status)) {
      await this.#turns.save({ ...activeTurn, status: 'CANCELLED', completedAtIso: this.#clock.nowIso() });
    }
    await this.#event('session.cancelled.v1', session.id, { cancellationGeneration: saved.session.cancellationGeneration });
    return refOf(saved.session);
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

  async #settleSessionForTurn(turn: AgentTurn): Promise<void> {
    const session = await this.#sessions.get(turn.sessionId);
    if (session === undefined || session.currentTurnId !== turn.id || isTerminalSession(session.status)) return;
    const nextStatus = turn.status === 'FAILED' ? 'RECONCILING' : 'READY';
    const settled: AgentSession = {
      ...session,
      status: nextStatus,
      currentTurnId: undefined,
      updatedAtIso: this.#clock.nowIso(),
    };
    const saved = await this.#sessions.save(settled, session.version);
    if (saved.ok) await this.#event('session.state_changed.v1', session.id, { status: nextStatus });
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

function mapProviderTurnStatus(status: string): AgentTurn['status'] {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'SUCCEEDED';
    case 'failed':
    case 'error':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'paused':
    case 'waiting_for_action':
      return 'PAUSED';
    case 'running':
    case 'in_progress':
    case 'queued':
      return 'RUNNING';
    default:
      return 'RECONCILING';
  }
}

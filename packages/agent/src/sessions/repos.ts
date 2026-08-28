/**
 * C037 §13/§19/§20 — session/turn repositories (expected-version CAS + replay).
 *
 * In-memory stores enforce: duplicate command key replays the existing record;
 * the same key with a different digest fails; at most one nonterminal turn per
 * session (one-active-turn); and expected-version CAS guards worker races.
 */
import { createHash } from 'node:crypto';
import type { AgentSession, AgentTurn } from './contracts.js';

export interface SessionStorePort {
  get(id: string): Promise<AgentSession | undefined>;
  findByCommandKey(commandKey: string): Promise<AgentSession | undefined>;
  save(
    session: AgentSession,
    expectedVersion: number,
  ): Promise<{ ok: true; session: AgentSession } | { ok: false; code: 'VERSION_CONFLICT' }>;
}

export interface TurnStorePort {
  get(turnId: string): Promise<AgentTurn | undefined>;
  findByCommandKey(commandKey: string): Promise<AgentTurn | undefined>;
  countActive(sessionId: string): Promise<number>;
  nextOrdinal(sessionId: string): Promise<number>;
  save(turn: AgentTurn): Promise<void>;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Deterministic DevGuard session id from an ensure-session command key. */
export function sessionIdForCommand(commandKey: string): string {
  return sha256Hex(`session:${commandKey}`).slice(0, 32);
}

export class InMemorySessionStore implements SessionStorePort {
  readonly sessions = new Map<string, AgentSession>();

  async get(id: string): Promise<AgentSession | undefined> {
    return this.sessions.get(id);
  }
  async findByCommandKey(commandKey: string): Promise<AgentSession | undefined> {
    return this.sessions.get(sessionIdForCommand(commandKey));
  }
  async save(
    session: AgentSession,
    expectedVersion: number,
  ): Promise<{ ok: true; session: AgentSession } | { ok: false; code: 'VERSION_CONFLICT' }> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined && existing.version !== expectedVersion)
      return { ok: false, code: 'VERSION_CONFLICT' };
    const next = { ...session, version: session.version + 1 };
    this.sessions.set(next.id, next);
    return { ok: true, session: next };
  }
}

export class InMemoryTurnStore implements TurnStorePort {
  readonly turns = new Map<string, AgentTurn>();
  readonly byCommand = new Map<string, AgentTurn>();

  async get(turnId: string): Promise<AgentTurn | undefined> {
    return this.turns.get(turnId);
  }
  async findByCommandKey(commandKey: string): Promise<AgentTurn | undefined> {
    return this.byCommand.get(commandKey);
  }
  async countActive(sessionId: string): Promise<number> {
    let n = 0;
    for (const t of this.turns.values()) {
      if (t.sessionId === sessionId && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.status))
        n += 1;
    }
    return n;
  }
  async nextOrdinal(sessionId: string): Promise<number> {
    let max = 0;
    for (const t of this.turns.values())
      if (t.sessionId === sessionId && t.ordinal > max) max = t.ordinal;
    return max + 1;
  }
  async save(turn: AgentTurn): Promise<void> {
    this.turns.set(turn.id, turn);
    this.byCommand.set(turn.commandKey, turn);
  }
}

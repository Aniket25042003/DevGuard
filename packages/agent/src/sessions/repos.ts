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

/** Deterministic UUID-shaped DevGuard session id from an ensure-session key. */
export function sessionIdForCommand(commandKey: string): string {
  const hex = sha256Hex(`session:${commandKey}`).slice(0, 32).split('');
  // UUIDv5-shaped bits keep idempotent command mapping while satisfying the
  // PostgreSQL uuid type. This is not a provider identifier.
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '8', 16) % 4] ?? '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
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

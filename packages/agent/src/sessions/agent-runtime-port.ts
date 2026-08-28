/**
 * C037 §10 — agent runtime port (provider-neutral).
 *
 * Only verified create/get/resume semantics are exposed (C036). Provider types
 * never cross; results are normalized DevGuard refs. The in-memory fake gives
 * deterministic control for session/turn lifecycle tests.
 */
export type AgentRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export interface AgentRuntimePort {
  createSession(input: {
    provider: string;
    agentVersion: string;
  }): Promise<
    AgentRuntimeResult<{ providerSessionId: string; providerThreadId?: string | undefined }>
  >;
  createTurn(input: {
    providerSessionId: string;
    ordinal: number;
  }): Promise<AgentRuntimeResult<{ providerTurnId: string }>>;
  getTurnStatus(input: {
    providerSessionId: string;
    providerTurnId: string;
  }): Promise<AgentRuntimeResult<{ status: string; terminalReason?: string | undefined }>>;
}

export class InMemoryAgentRuntimePort implements AgentRuntimePort {
  sessionIds = 0;
  turnIds = 0;
  requests = 0;
  sessionState: string = 'ready';
  failNext: { op: 'createSession' | 'createTurn'; code: string } | undefined;

  async createSession(): Promise<
    AgentRuntimeResult<{ providerSessionId: string; providerThreadId?: string | undefined }>
  > {
    this.requests += 1;
    if (this.failNext?.op === 'createSession') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected' };
    }
    this.sessionIds += 1;
    return {
      ok: true,
      value: {
        providerSessionId: `pf-s${this.sessionIds}`,
        providerThreadId: `th-${this.sessionIds}`,
      },
    };
  }

  async createTurn(): Promise<AgentRuntimeResult<{ providerTurnId: string }>> {
    this.requests += 1;
    if (this.failNext?.op === 'createTurn') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected' };
    }
    this.turnIds += 1;
    return { ok: true, value: { providerTurnId: `pf-t${this.turnIds}` } };
  }

  async getTurnStatus(): Promise<
    AgentRuntimeResult<{ status: string; terminalReason?: string | undefined }>
  > {
    return { ok: true, value: { status: this.sessionState } };
  }
}

/**
 * CP013 (C036/C037/C039) — TrueForge agent runtime adapter.
 *
 * Maps the provider-neutral `AgentRuntimePort` to a pinned TrueForge HTTP
 * contract. The integration is DISABLED by default (feature-flag fail-closed):
 * with `enabled:false` every operation returns `PROVIDER_INCOMPATIBLE` and no
 * network call is made; preflight must succeed before any session/turn work.
 * No TrueForge SDK types cross this file's public surface.
 */
import type { AgentRuntimePort, AgentRuntimeResult } from '../sessions/agent-runtime-port.js';

export interface TrueForgeHttpTransport {
  fetch(
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface TrueForgeHttpAgentRuntimeOptions {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: TrueForgeHttpTransport['fetch'] | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Normalized provider-incompatible result when the integration is off. */
export function trueforgeDisabled(): { ok: false; code: string; detail: string } {
  return { ok: false, code: 'PROVIDER_INCOMPATIBLE', detail: 'trueforge integration disabled' };
}

export class TrueForgeHttpAgentRuntime implements AgentRuntimePort {
  readonly transport: TrueForgeHttpTransport;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: TrueForgeHttpAgentRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.transport = { fetch: options.fetchImpl ?? globalThis.fetch.bind(globalThis) };
  }

  private async doPreflight(): Promise<AgentRuntimeResult<{ provider: string; version: string }>> {
    if (!this.options.enabled) return trueforgeDisabled();
    try {
      const res = await this.transport.fetch(`${this.baseUrl}/v1/identify`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = (await res.json()) as { provider?: string; version?: string };
      if (!res.ok || body.provider !== 'trueforge') {
        return {
          ok: false,
          code: 'PROVIDER_INCOMPATIBLE',
          detail: `identify failed (${res.status})`,
        };
      }
      return { ok: true, value: { provider: body.provider, version: body.version ?? 'unknown' } };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge identify timed out' };
    }
  }

  /** Idempotent preflight guard — every provider-capable surface calls this first. */
  async preflight(): Promise<AgentRuntimeResult<{ provider: string; version: string }>> {
    return this.doPreflight();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== undefined) h['authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async createSession(input: {
    provider: string;
    agentVersion: string;
  }): Promise<
    AgentRuntimeResult<{ providerSessionId: string; providerThreadId?: string | undefined }>
  > {
    const pre = await this.doPreflight();
    if (!pre.ok) return pre;
    if (input.provider !== 'trueforge') return trueforgeDisabled();
    try {
      const res = await this.transport.fetch(`${this.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ agentVersion: input.agentVersion }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `session create (${res.status})` };
      const body = (await res.json()) as { sessionId?: unknown; threadId?: unknown };
      if (
        typeof body.sessionId !== 'string' ||
        body.sessionId.length === 0 ||
        body.sessionId.length > 512 ||
        (body.threadId !== undefined &&
          (typeof body.threadId !== 'string' ||
            body.threadId.length === 0 ||
            body.threadId.length > 512))
      )
        return { ok: false, code: 'SERVER_ERROR', detail: 'session id missing' };
      return {
        ok: true,
        value: { providerSessionId: body.sessionId, providerThreadId: body.threadId },
      };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge createSession timed out' };
    }
  }

  async createTurn(input: {
    providerSessionId: string;
    ordinal: number;
  }): Promise<AgentRuntimeResult<{ providerTurnId: string }>> {
    const pre = await this.doPreflight();
    if (!pre.ok) return pre;
    try {
      const res = await this.transport.fetch(
        `${this.baseUrl}/v1/sessions/${encodeURIComponent(input.providerSessionId)}/turns`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ordinal: input.ordinal }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `turn create (${res.status})` };
      const body = (await res.json()) as { turnId?: unknown };
      if (typeof body.turnId !== 'string' || body.turnId.length === 0 || body.turnId.length > 512)
        return { ok: false, code: 'SERVER_ERROR', detail: 'turn id missing' };
      return { ok: true, value: { providerTurnId: body.turnId } };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge createTurn timed out' };
    }
  }

  async getTurnStatus(input: {
    providerSessionId: string;
    providerTurnId: string;
  }): Promise<AgentRuntimeResult<{ status: string; terminalReason?: string | undefined }>> {
    const pre = await this.doPreflight();
    if (!pre.ok) return pre;
    try {
      const res = await this.transport.fetch(
        `${this.baseUrl}/v1/sessions/${encodeURIComponent(input.providerSessionId)}/turns/${encodeURIComponent(input.providerTurnId)}`,
        { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `turn status (${res.status})` };
      const body = (await res.json()) as { status?: unknown };
      if (
        typeof body.status !== 'string' ||
        !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(body.status)
      )
        return { ok: false, code: 'SERVER_ERROR', detail: 'invalid turn status' };
      return { ok: true, value: { status: body.status } };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge getTurnStatus timed out' };
    }
  }
}

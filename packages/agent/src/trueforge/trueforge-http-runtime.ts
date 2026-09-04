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
  /** OSS TrueForge serves routes under `/api/v1`; legacy stubs used `/v1` only. */
  readonly apiPrefix?: string | undefined;
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
  private readonly apiPrefix: string;

  constructor(private readonly options: TrueForgeHttpAgentRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.apiPrefix = options.apiPrefix ?? '/api';
    this.transport = { fetch: options.fetchImpl ?? globalThis.fetch.bind(globalThis) };
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}${this.apiPrefix}/v1${path}`;
  }

  private async doPreflight(): Promise<AgentRuntimeResult<{ provider: string; version: string }>> {
    if (!this.options.enabled) return trueforgeDisabled();
    try {
      const capabilities = await this.transport.fetch(this.apiUrl('/capabilities'), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (capabilities.ok) {
        const body = (await capabilities.json()) as { data?: Record<string, unknown> };
        if (body.data !== undefined) {
          return { ok: true, value: { provider: 'trueforge', version: 'oss' } };
        }
      }

      const legacy = await this.transport.fetch(`${this.baseUrl}/v1/identify`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const identify = (await legacy.json()) as { provider?: string; version?: string };
      if (!legacy.ok || identify.provider !== 'trueforge') {
        return {
          ok: false,
          code: 'PROVIDER_INCOMPATIBLE',
          detail: `preflight failed (${capabilities.status}/${legacy.status})`,
        };
      }
      return {
        ok: true,
        value: { provider: identify.provider, version: identify.version ?? 'unknown' },
      };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge preflight timed out' };
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
      const res = await this.transport.fetch(this.apiUrl('/sessions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          agent: { name: input.agentVersion },
          agentVersion: input.agentVersion,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `session create (${res.status})` };
      const body = (await res.json()) as {
        sessionId?: string;
        threadId?: string;
        data?: { sessionId?: string; threadId?: string; id?: string };
      };
      const sessionId = body.sessionId ?? body.data?.sessionId ?? body.data?.id;
      const threadId = body.threadId ?? body.data?.threadId;
      if (sessionId === undefined)
        return { ok: false, code: 'SERVER_ERROR', detail: 'session id missing' };
      return {
        ok: true,
        value: {
          providerSessionId: sessionId,
          ...(threadId !== undefined ? { providerThreadId: threadId } : {}),
        },
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
        this.apiUrl(`/sessions/${encodeURIComponent(input.providerSessionId)}/turns`),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ordinal: input.ordinal }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `turn create (${res.status})` };
      const body = (await res.json()) as {
        turnId?: string;
        data?: { turnId?: string; id?: string };
      };
      const turnId = body.turnId ?? body.data?.turnId ?? body.data?.id;
      if (turnId === undefined)
        return { ok: false, code: 'SERVER_ERROR', detail: 'turn id missing' };
      return { ok: true, value: { providerTurnId: turnId } };
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
        this.apiUrl(
          `/sessions/${encodeURIComponent(input.providerSessionId)}/turns/${encodeURIComponent(input.providerTurnId)}`,
        ),
        { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!res.ok)
        return { ok: false, code: 'SERVER_ERROR', detail: `turn status (${res.status})` };
      const body = (await res.json()) as { status?: string; data?: { status?: string } };
      return { ok: true, value: { status: body.status ?? body.data?.status ?? 'unknown' } };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: 'trueforge getTurnStatus timed out' };
    }
  }
}

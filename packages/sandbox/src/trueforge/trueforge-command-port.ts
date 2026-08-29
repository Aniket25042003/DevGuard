/**
 * CP013 (C040/C041/C042) — TrueForge sandbox command port.
 *
 * Commands run in a TrueForge-managed workspace over HTTP; DevGuard NEVER
 * spawns host processes (`hostFilesystem:false`). Disabled by default → fails
 * closed `SERVER_ERROR` with no network. One active command per workspace.
 */
import type {
  CommandProviderResult,
  ProviderOutputChunk,
  ProviderStreamSlice,
  TrueForgeCommandPort,
} from '../commands/command-provider-port.js';
import type { SandboxCommand } from '../commands/contracts.js';

interface FetchLike {
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

export interface TrueForgeCommandPortOptions {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: FetchLike['fetch'] | undefined;
  readonly timeoutMs?: number | undefined;
}

export class TrueForgeHttpCommandPort implements TrueForgeCommandPort {
  readonly hostFilesystem = false;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike['fetch'];
  private commandId: string | undefined;

  constructor(private readonly options: TrueForgeCommandPortOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== undefined) h['authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async run<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<CommandProviderResult<T> | undefined> {
    if (!this.options.enabled) return undefined;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { ok: false, code: 'SERVER_ERROR', detail: `${path} (${res.status})` };
      const value = await res.json();
        if (value === null || typeof value !== 'object') return { ok: false, code: 'SERVER_ERROR', detail: `${path} invalid response` };
        return { ok: true, value: value as T };
    } catch {
      return { ok: false, code: 'TIMEOUT', detail: `${path} timed out` };
    }
  }

  async execute(
    command: SandboxCommand,
  ): Promise<CommandProviderResult<{ providerCommandId: string }>> {
    const disabled: CommandProviderResult<{ providerCommandId: string }> | undefined =
      await this.run<{ providerCommandId: string }>('POST', '/v1/workspace/commands', command);
    if (disabled === undefined)
      return { ok: false, code: 'SERVER_ERROR', detail: 'sandbox integration disabled' };
    if (!disabled.ok) return disabled;
    this.commandId = disabled.value.providerCommandId;
    return disabled;
  }

  async stream(cursor: number): Promise<CommandProviderResult<ProviderStreamSlice>> {
    if (!this.options.enabled) return { ok: false, code: 'SERVER_ERROR', detail: 'sandbox integration disabled' };
      const id = this.commandId;
    if (id === undefined) return { ok: false, code: 'NOT_FOUND', detail: 'no active command' };
    const out = await this.run<Record<string, unknown>>(
      'GET',
      `/v1/workspace/commands/${encodeURIComponent(id)}/stream?cursor=${cursor}`,
    );
    if (out === undefined)
      return { ok: false, code: 'SERVER_ERROR', detail: 'sandbox integration disabled' };
    if (!out.ok) return out;
    const chunks = Array.isArray(out.value['chunks'])
      ? (out.value['chunks'] as ProviderOutputChunk[])
      : [];
    const rawState = (out.value['state'] ?? {}) as { running?: boolean; exitCode?: number };
    return {
      ok: true,
      value: {
        chunks,
        done: out.value['done'] === true,
        state: {
          running: rawState.running ?? true,
          ...(rawState.exitCode !== undefined ? { exitCode: rawState.exitCode } : {}),
        },
        nextCursor: cursor + chunks.length,
      },
    };
  }

  async inspect(): Promise<
    CommandProviderResult<{
      running: boolean;
      exitCode?: number | undefined;
      signal?: string | undefined;
    }>
  > {
    const disabled:
      CommandProviderResult<{ running: boolean; exitCode?: number; signal?: string }> | undefined =
      await this.run<{ running: boolean }>('GET', '/v1/workspace/status');
    if (disabled === undefined)
      return { ok: false, code: 'SERVER_ERROR', detail: 'sandbox integration disabled' };
    return disabled;
  }

  async terminate(): Promise<CommandProviderResult<{ terminated: boolean }>> {
    const disabled: CommandProviderResult<{ terminated: boolean }> | undefined = await this.run<{
      terminated: boolean;
    }>('POST', '/v1/workspace/commands/terminate', {});
    if (disabled === undefined)
      return { ok: false, code: 'CANCEL_UNSUPPORTED', detail: 'sandbox integration disabled' };
    return disabled;
  }
}

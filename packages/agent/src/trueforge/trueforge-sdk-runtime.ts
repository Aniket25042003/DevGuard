/**
 * Production TrueForge adapter backed by the pinned official SDK.
 *
 * The SDK owns URL construction, authentication, retries, response parsing,
 * and resumable streams. This adapter deliberately exposes only DevGuard's
 * provider-neutral port so provider types cannot leak into workflow code.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { AgentRuntimePort, AgentRuntimeResult } from '../sessions/agent-runtime-port.js';

export interface TrueForgeSdkAgentRuntimeOptions {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const disabled = (): { ok: false; code: string; detail: string } => ({
  ok: false,
  code: 'PROVIDER_INCOMPATIBLE',
  detail: 'trueforge integration disabled',
});

function failure(error: unknown): { ok: false; code: string; detail: string } {
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  if (status === 401 || status === 403)
    return { ok: false, code: 'UNAUTHORIZED', detail: 'trueforge authorization failed' };
  if (status === 404)
    return { ok: false, code: 'PROVIDER_INCOMPATIBLE', detail: 'trueforge resource not found' };
  if (status !== undefined && status >= 500)
    return { ok: false, code: 'SERVER_ERROR', detail: `trueforge server error (${status})` };
  return { ok: false, code: 'TIMEOUT', detail: 'trueforge request failed or timed out' };
}

export class TrueForgeSdkAgentRuntime implements AgentRuntimePort {
  private readonly client: TrueForge | undefined;
  private readonly timeoutInSeconds: number;

  constructor(private readonly options: TrueForgeSdkAgentRuntimeOptions) {
    this.timeoutInSeconds = Math.max(1, Math.ceil((options.timeoutMs ?? 15_000) / 1000));
    if (options.enabled) {
      this.client = new TrueForge({
        baseUrl: options.baseUrl.replace(/\/$/, ''),
        ...(options.apiKey !== undefined ? { token: options.apiKey } : {}),
        ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
        timeoutInSeconds: this.timeoutInSeconds,
        maxRetries: 2,
      });
    }
  }

  async preflight(): Promise<AgentRuntimeResult<{ provider: string; version: string }>> {
    if (!this.options.enabled || this.client === undefined) return disabled();
    try {
      const response = await this.client.server.getCapabilities({
        timeoutInSeconds: this.timeoutInSeconds,
      });
      const data = response.data as unknown as Record<string, unknown>;
      const version = typeof data['version'] === 'string' ? data['version'] : 'unknown';
      return { ok: true, value: { provider: 'trueforge', version } };
    } catch (error) {
      return failure(error);
    }
  }

  async createSession(input: {
    provider: string;
    agentVersion: string;
  }): Promise<AgentRuntimeResult<{ providerSessionId: string; providerThreadId?: string }>> {
    if (input.provider !== 'trueforge' || this.client === undefined) return disabled();
    const preflight = await this.preflight();
    if (!preflight.ok) return preflight;
    try {
      const response = await this.client.sessions.create(
        { agent: { name: input.agentVersion } },
        { timeoutInSeconds: this.timeoutInSeconds },
      );
      return { ok: true, value: { providerSessionId: response.data.id } };
    } catch (error) {
      return failure(error);
    }
  }

  async createTurn(input: {
    providerSessionId: string;
    ordinal: number;
  }): Promise<AgentRuntimeResult<{ providerTurnId: string }>> {
    if (this.client === undefined) return disabled();
    try {
      // TrueForge's empty input is a valid turn. The ordinal remains a
      // DevGuard sequencing concern and is intentionally not sent as an
      // undocumented provider field.
      void input.ordinal;
      const response = await this.client.sessions.createTurn(
        input.providerSessionId,
        {},
        { timeoutInSeconds: this.timeoutInSeconds },
      );
      return { ok: true, value: { providerTurnId: response.data.id } };
    } catch (error) {
      return failure(error);
    }
  }

  async cancelSession(input: {
    providerSessionId: string;
  }): Promise<AgentRuntimeResult<{ cancelled: boolean }>> {
    if (this.client === undefined) return disabled();
    try {
      await this.client.sessions.cancel(input.providerSessionId, {
        timeoutInSeconds: this.timeoutInSeconds,
      });
      return { ok: true, value: { cancelled: true } };
    } catch (error) {
      return failure(error);
    }
  }

  async getTurnStatus(input: {
    providerSessionId: string;
    providerTurnId: string;
  }): Promise<AgentRuntimeResult<{ status: string; terminalReason?: string }>> {
    if (this.client === undefined) return disabled();
    try {
      const response = await this.client.sessions.getTurn(
        input.providerSessionId,
        input.providerTurnId,
        { timeoutInSeconds: this.timeoutInSeconds },
      );
      const state = response.data.state as { status: string; error?: string };
      return {
        ok: true,
        value: {
          status: state.status,
          ...(typeof state.error === 'string' ? { terminalReason: state.error } : {}),
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}

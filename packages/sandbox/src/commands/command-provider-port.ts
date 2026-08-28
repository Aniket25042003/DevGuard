/**
 * C042 §10/§15 — TrueForge command provider port.
 *
 * execute/stream/inspect/terminate are the ONLY provider operations the runner
 * calls; provider types never cross. Deadline/cancellation is authoritative in
 * DevGuard; termination must stop the process tree (verified capability). The
 * in-memory fake gives deterministic control for unit tests.
 */
import type { SandboxCommand } from './contracts.js';

export type CommandProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'CANCEL_UNSUPPORTED' | 'SERVER_ERROR' | 'TIMEOUT';
      readonly detail: string;
    };

export interface ProviderOutputChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly cursor: number;
}

export interface ProviderStreamSlice {
  readonly chunks: readonly ProviderOutputChunk[];
  readonly done: boolean;
  readonly state: {
    readonly running: boolean;
    readonly exitCode?: number | undefined;
    readonly signal?: string | undefined;
  };
  readonly nextCursor: number;
}

export interface TrueForgeCommandPort {
  execute(command: SandboxCommand): Promise<CommandProviderResult<{ providerCommandId: string }>>;
  stream(cursor: number): Promise<CommandProviderResult<ProviderStreamSlice>>;
  inspect(): Promise<
    CommandProviderResult<{
      running: boolean;
      exitCode?: number | undefined;
      signal?: string | undefined;
    }>
  >;
  terminate(): Promise<CommandProviderResult<{ terminated: boolean }>>;
}

/** Deterministic in-memory command provider for unit tests. */
export class InMemoryCommandProvider implements TrueForgeCommandPort {
  executed = 0;
  terminated = 0;
  running = true;
  exitCode: number | undefined;
  signal: string | undefined;
  readonly streamed: ProviderOutputChunk[] = [];
  failNext:
    | { op: 'execute' | 'terminate'; code: 'CANCEL_UNSUPPORTED' | 'SERVER_ERROR' | 'TIMEOUT' }
    | undefined;

  pushChunk(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.streamed.push({ stream, text, cursor: this.streamed.length });
  }

  finish(exitCode: number): void {
    this.running = false;
    this.exitCode = exitCode;
  }

  async execute(): Promise<CommandProviderResult<{ providerCommandId: string }>> {
    if (this.failNext?.op === 'execute') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected execute failure' };
    }
    this.executed += 1;
    return { ok: true, value: { providerCommandId: `pc-${this.executed}` } };
  }

  async stream(cursor: number): Promise<CommandProviderResult<ProviderStreamSlice>> {
    const chunks = this.streamed.slice(cursor);
    return {
      ok: true,
      value: {
        chunks,
        done: !this.running,
        state: { running: this.running, exitCode: this.exitCode, signal: this.signal },
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
    return {
      ok: true,
      value: { running: this.running, exitCode: this.exitCode, signal: this.signal },
    };
  }

  async terminate(): Promise<CommandProviderResult<{ terminated: boolean }>> {
    if (this.failNext?.op === 'terminate') {
      const code = this.failNext.code;
      this.failNext = undefined;
      return { ok: false, code, detail: 'injected termination failure' };
    }
    this.terminated += 1;
    this.running = false;
    return { ok: true, value: { terminated: true } };
  }
}

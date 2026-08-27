/**
 * C061 §9/§10 — LoggerPort with child contexts, AsyncLocalStorage correlation,
 * safe error serialization and a pluggable sink.
 *
 * Pipeline: record assembly (allowlist + budgets) → redaction → sampling →
 * sink. Sink failures DEGRADE to stderr; logging never breaks the product
 * (C061 §9), except audit durability which lives in C064, not here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { DevGuardError } from '@devguard/errors';
import {
  LOG_BUDGETS,
  redactText,
  redactValue,
  type LogLevel,
  type LogService,
  type OperationalLogRecord,
  type SafeLogFields,
  type SerializedError,
} from './schema.js';

export type LogSink = (record: OperationalLogRecord, serialized: string) => void;

export interface CorrelationContext {
  readonly correlationId: string;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
}

/** Deterministic error fingerprint: code + safe message shape, no payloads. */
export function serializeError(error: unknown): SerializedError | undefined {
  if (error === undefined || error === null) return undefined;
  const guard = error as Partial<DevGuardError> & { code?: unknown };
  const code = typeof guard.code === 'string' ? guard.code : 'UNCLASSIFIED';
  const retryClass = typeof guard.retryClass === 'string' ? guard.retryClass : 'unknown';
  const message =
    typeof (error as Error)?.message === 'string'
      ? redactText((error as Error).message).slice(0, 200)
      : '';
  return Object.freeze({
    code,
    class: retryClass,
    retryable: retryClass === 'safe_retry',
    fingerprint: createHash('sha256').update(`${code}|${message}`).digest('hex').slice(0, 32),
  });
}

export class CorrelationContextPort {
  private readonly storage = new AsyncLocalStorage<CorrelationContext>();

  current(): CorrelationContext {
    return this.storage.getStore() ?? { correlationId: 'unset' };
  }

  run<T>(ctx: CorrelationContext, fn: () => T): T {
    return this.storage.run(ctx, fn);
  }

  /** Cross-process/job propagation helper (envelopes carry correlationId). */
  static fromJob(jobContext: {
    readonly correlationId: string;
    readonly traceparent?: string | undefined;
  }): CorrelationContext {
    const traceparent = jobContext.traceparent;
    const parts = traceparent?.split('-');
    return {
      correlationId: jobContext.correlationId,
      traceId: parts?.[1],
      spanId: parts?.[2],
    };
  }
}

export interface LoggerOptions {
  readonly service: LogService;
  readonly environment: string;
  readonly sink: LogSink;
  /** Sample fraction for info/debug (0..1); warn/error always emit. */
  readonly debugSampleRate?: number | undefined;
  readonly correlation?: CorrelationContextPort | undefined;
  readonly minLevel?: LogLevel | undefined;
  readonly now?: () => number;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
});

export class LoggerPort {
  #context: Partial<SafeLogFields> & { readonly correlationId: string };

  constructor(
    private readonly options: LoggerOptions,
    context: { correlationId: string } & Partial<SafeLogFields>,
  ) {
    this.#context = context;
  }

  static root(options: LoggerOptions): LoggerPort {
    const correlation = options.correlation ?? new CorrelationContextPort();
    const root = new LoggerPort(options, { correlationId: 'root' });
    void correlation;
    return root;
  }

  child(extra: Partial<SafeLogFields>): LoggerPort {
    // Child inherits immutable merged context; correlation still flows from ALS.
    return new LoggerPort(this.options, {
      ...this.#context,
      ...extra,
      correlationId: this.#context.correlationId,
    });
  }

  #emit(level: LogLevel, event: string, fields: SafeLogFields | undefined, error?: unknown): void {
    const min = this.options.minLevel ?? 'debug';
    if (LEVEL_ORDER[level] < LEVEL_ORDER[min]) return;
    if (
      level === 'debug' &&
      this.options.debugSampleRate !== undefined &&
      this.options.debugSampleRate < 1
    ) {
      // Deterministic-ish sampling: skip when below threshold.
      if (Math.random() > this.options.debugSampleRate) return;
    }
    const correlation = this.options.correlation?.current() ?? {
      correlationId: this.#context.correlationId,
    };
    const merged = redactValue({ ...(this.#context as object), ...fields }) as SafeLogFields &
      Record<string, unknown>;
    // Budget-truncated, redacted message; the stable semantic name rides in `event`.
    const message: string = redactText(event).slice(0, LOG_BUDGETS.maxMessageLength);
    const record: OperationalLogRecord = {
      schemaVersion: 1,
      timestamp: new Date((this.options.now ?? Date.now)()).toISOString(),
      level,
      service: this.options.service,
      environment: this.options.environment,
      message,
      // Static child context first; live correlation ALWAYS wins so tracing
      // survives async boundaries (C061 §3).
      ...merged,
      correlationId: correlation.correlationId,
      ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation.traceId ? { traceId: correlation.traceId } : {}),
      ...(correlation.spanId ? { spanId: correlation.spanId } : {}),
      event,
      ...(error !== undefined && error !== null ? { error: serializeError(error) } : {}),
    };
    // Field allowlist enforcement happens during serialization: drop unknown keys.
    const json = this.#serialize(record);
    try {
      this.options.sink(record, json);
    } catch {
      // Sinks must never crash the process (C061 §9 DEGRADED path):
      // degrade to raw stderr without throwing.
      process.stderr.write(`${json}\n`);
    }
  }

  #serialize(record: OperationalLogRecord): string {
    // Allowlist serialization: correlation/corridor fields only + allowed extras.
    const ordered: Record<string, unknown> = {};
    const asRecord = record as unknown as Record<string, unknown>;
    for (const key of [
      'schemaVersion',
      'timestamp',
      'level',
      'service',
      'environment',
      'message',
      'event',
      'requestId',
      'correlationId',
      'traceId',
      'spanId',
      'repositoryId',
      'workflowRunId',
      'sessionId',
      'actionId',
      'approvalId',
      'jobId',
      'webhookDeliveryId',
      'actorType',
      'actorIdHash',
      'provider',
      'durationMs',
      'status',
      'attempt',
      'error',
    ]) {
      if (asRecord[key] !== undefined) {
        ordered[key] = asRecord[key];
      }
    }
    let json = JSON.stringify(ordered);
    if (Buffer.byteLength(json, 'utf8') > LOG_BUDGETS.maxJsonBytes) {
      // Truncate oversized messages before re-serializing (budget C061 §5).
      ordered['message'] = `${String(ordered['message']).slice(0, 128)}…[truncated]`;
      json = JSON.stringify(ordered);
    }
    return json;
  }

  debug(event: string, fields?: SafeLogFields): void {
    this.#emit('debug', event, fields);
  }
  info(event: string, fields?: SafeLogFields): void {
    this.#emit('info', event, fields);
  }
  warn(event: string, fields?: SafeLogFields): void {
    this.#emit('warn', event, fields);
  }
  error(event: string, error: unknown, fields?: SafeLogFields): void {
    this.#emit('error', event, fields, error);
  }
  fatal(event: string, error: unknown, fields?: SafeLogFields): void {
    this.#emit('fatal', event, fields, error);
  }

  async flush(): Promise<void> {
    // Default sink is synchronous; async sinks override via composition.
    await Promise.resolve();
  }
}

/** In-memory capture sink for tests/diagnostics (C061 §3 verification). */
export class MemorySink {
  readonly records: OperationalLogRecord[] = [];
  readonly serializedLines: string[] = [];

  readonly sink: LogSink = (record, serialized) => {
    this.records.push(record);
    this.serializedLines.push(serialized);
  };

  flush(): readonly OperationalLogRecord[] {
    return [...this.records];
  }
}

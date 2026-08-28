/**
 * C014/C015/C016 — shared read-component ports: structured logging and
 * outbox-style event emission.
 *
 * Logging conforms to C061: event names ride in `event`, fields are the
 * allowlisted safe-field set, and sinks redact. Event emission is
 * best-effort domain signaling; it never blocks or grants reads, and it can
 * never be interpreted as authorization.
 */
import type { SafeLogFields } from '@devguard/logging';

/**
 * Narrow logger surface satisfied by `LoggerPort` from @devguard/logging
 * (C061). `error` carries the error object separately so serialization can
 * stay redacted and correlation-aware.
 */
export interface ComponentLogPort {
  debug(event: string, fields?: SafeLogFields): void;
  info(event: string, fields?: SafeLogFields): void;
  warn(event: string, fields?: SafeLogFields): void;
  error(event: string, error: unknown, fields?: SafeLogFields): void;
}

/** Default no-op logger for tests and composition until wiring provides one. */
export class NoopLogPort implements ComponentLogPort {
  debug(_event: string, _fields?: SafeLogFields): void {}
  info(_event: string, _fields?: SafeLogFields): void {}
  warn(_event: string, _fields?: SafeLogFields): void {}
  error(_event: string, _error: unknown, _fields?: SafeLogFields): void {}
}

/** Stable event names emitted by the read components (C014 §10, C015 §10, C016 §10). */
export const READ_COMPONENT_EVENTS = [
  'repository.metadata.refreshed',
  'repository.health.changed',
  'repository.metadata.stale',
  'repository.map.started',
  'repository.map.created',
  'repository.map.partial',
  'repository.map.superseded',
  'instruction.loaded',
  'instruction.rejected',
  'instruction.conflict.detected',
  'instruction.snapshot.created',
  'instruction.snapshot.superseded',
] as const;

export type ReadComponentEventType = (typeof READ_COMPONENT_EVENTS)[number];

export interface EmittedReadEvent {
  readonly type: ReadComponentEventType;
  readonly aggregateId: string;
  readonly correlationId?: string | undefined;
  /** Normalized, non-sensitive payload (hashes/paths/reason codes only). */
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Outbox-style event port. Persistence of these events belongs to the
 * platform event bus (deferred); the in-memory fake keeps unit tests
 * deterministic.
 */
export interface EventSinkPort {
  emit(event: EmittedReadEvent): Promise<void>;
}

/** Deterministic in-memory event sink for unit tests and composition. */
export class InMemoryEventSink implements EventSinkPort {
  readonly emitted: EmittedReadEvent[] = [];

  async emit(event: EmittedReadEvent): Promise<void> {
    this.emitted.push(event);
  }

  ofType(type: ReadComponentEventType): readonly EmittedReadEvent[] {
    return this.emitted.filter((event) => event.type === type);
  }

  clear(): void {
    this.emitted.length = 0;
  }
}

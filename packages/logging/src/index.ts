/**
 * @devguard/logging — operational logging (C061).
 *
 * Boundary rule: logs are TTL-bound operations data. Durable domain evidence
 * flows through C011/C063/C064 repositories, never through this package.
 */
export {
  LOG_BUDGETS,
  redactText,
  redactValue,
  type LogLevel,
  type LogService,
  type OperationalLogRecord,
  type SafeLogFields,
  type SerializedError,
} from './schema.js';
export {
  CorrelationContextPort,
  LoggerPort,
  MemorySink,
  serializeError,
  type CorrelationContext,
  type LogSink,
  type LoggerOptions,
} from './logger.js';

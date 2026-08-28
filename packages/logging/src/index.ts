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

// ---- C062 metrics + tracing ----
export {
  MetricCatalog,
  InMemoryMetricsPort,
  TagPolicy,
  InMemoryTracingPort,
  type ApprovedLabels,
  type MetricsPort,
  type SpanPort,
  type TracingPort,
} from './observability/metrics-tracing.js';

// ---- C063 event timeline + action ledger ----
export {
  InMemoryTimelineStore,
  InMemoryActionLedger,
  type ActionLedgerEntry,
  type ActionLedgerPort,
  type ActionProposal,
  type ActionTransition,
  type NewTimelineEvent,
  type TimelineAppender,
  type TimelineReader,
  type WorkflowEvent,
} from './observability/timeline-ledger.js';

// ---- C064 audit / health / diagnostics ----
export {
  InMemoryAuditWriter,
  AuditIntegrityVerifier,
  HealthService,
  InMemoryPreflightService,
  InMemoryDiagnosticService,
  type AuditRecord,
  type AuditWriter,
  type FailureDiagnostic,
  type DiagnosticServicePort,
  type HealthLevel,
  type HealthProbe,
  type IntegrityResult,
  type NewAuditRecord,
  type PreflightReport,
  type Readiness,
} from './observability/audit-health.js';

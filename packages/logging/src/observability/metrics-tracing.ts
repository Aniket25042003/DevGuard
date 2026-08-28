/**
 * C062 §9/§10 — metrics + distributed tracing ports.
 *
 * Metrics use typed methods from a MintCatalog/TagPolicy with a cardinality
 * guard (unknown labels rejected; series estimated in tests). Spans carry only
 * safe (ID-only, non-content) attributes and can never trigger workflows or
 * approvals — telemetry is observational, not authoritative.
 */
import { createHash } from 'node:crypto';

export type ApprovedLabels = Readonly<Record<string, string>>;

export interface MetricsPort {
  increment(name: string, value: number, labels: ApprovedLabels): void;
  gauge(name: string, value: number, labels: ApprovedLabels): void;
  histogram(name: string, value: number, labels: ApprovedLabels): void;
}

export class InMemoryMetricsPort implements MetricsPort {
  readonly counts = new Map<string, number>();
  readonly series = new Set<string>();
  increment(name: string, value: number, labels: ApprovedLabels): void {
    const key = seriesKey(name, labels);
    this.counts.set(key, (this.counts.get(key) ?? 0) + value);
    this.series.add(key);
  }
  gauge(name: string, value: number, labels: ApprovedLabels): void {
    this.series.add(seriesKey(name, labels));
    void value;
  }
  histogram(name: string, value: number, labels: ApprovedLabels): void {
    this.series.add(seriesKey(name, labels));
    void value;
  }
}

function seriesKey(name: string, labels: ApprovedLabels): string {
  return `${name}{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}}`;
}

/** TagPolicy: only registered labels are allowed (cardinality guard). */
export class TagPolicy {
  constructor(private readonly allowed: ReadonlyMap<string, ReadonlySet<string>>) {}

  approve(labels: ApprovedLabels): ApprovedLabels {
    for (const [key] of Object.entries(labels)) {
      const values = this.allowed.get(key);
      if (values === undefined) throw new Error('METRIC_LABEL_UNKNOWN');
      const value = labels[key];
      if (value !== undefined && !values.has(value)) throw new Error('METRIC_LABEL_VALUE_DENIED');
    }
    return labels;
  }
}

/** MetricCatalog: typed methods instead of arbitrary names/labels. */
export class MetricCatalog {
  constructor(
    private readonly metrics: MetricsPort,
    private readonly policy: TagPolicy,
  ) {}

  incrementCommandStarted(commandClass: string): void {
    this.metrics.increment(
      'sandbox.command.started',
      1,
      this.policy.approve({ component: 'sandbox', class: commandClass }),
    );
  }

  incrementWebhookAccepted(): void {
    this.metrics.increment('webhook.accepted', 1, this.policy.approve({ component: 'webhook' }));
  }

  recordRunCompleted(outcome: string): void {
    this.metrics.increment(
      'workflow.run.completed',
      1,
      this.policy.approve({ component: 'workflow', outcome }),
    );
  }
}

export interface SpanPort {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface TracingPort {
  startActiveSpan<T>(name: string, fn: (span: SpanPort) => T): T;
}

export class InMemoryTracingPort implements TracingPort {
  readonly spans: Array<Record<string, string>> = [];
  startActiveSpan<T>(name: string, fn: (span: SpanPort) => T): T {
    const traceId = hex16();
    const spanId = hex16();
    const attrs: Record<string, string> = { name, traceId, spanId };
    const span: SpanPort = {
      traceId,
      spanId,
      setAttribute: (k, v) => {
        // Safe attribute policy: IDs only, never source/payload/content.
        if (SAFE_ATTR_PREFIXES.some((p) => k.startsWith(p))) attrs[k] = v;
      },
      recordException: () => undefined,
      end: () => undefined,
    };
    this.spans.push(attrs);
    return fn(span);
  }
}

const SAFE_ATTR_PREFIXES = [
  'repository.id.',
  'workflow.run.',
  'step.id.',
  'action.id.',
  'approval.id.',
];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hex16(): string {
  return sha256(String(Math.random() * Date.now())).slice(0, 16);
}

export const telemetryContractsSchema = {};

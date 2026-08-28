import { describe, expect, it } from 'vitest';
import { InMemoryMetricsPort, MetricCatalog, TagPolicy } from './metrics-tracing.js';
import { InMemoryTimelineStore, InMemoryActionLedger } from './timeline-ledger.js';
import {
  InMemoryAuditWriter,
  AuditIntegrityVerifier,
  HealthService,
  InMemoryPreflightService,
  InMemoryDiagnosticService,
} from './audit-health.js';

describe('C062 metrics/tracing', () => {
  it('enforces the label tag policy (cardinality guard)', () => {
    const policy = new TagPolicy(
      new Map([['component', new Set(['sandbox', 'webhook', 'workflow'])]]),
    );
    expect(() => policy.approve({ component: 'unknown' })).toThrow();
    expect(() => policy.approve({ notAllowed: 'x' })).toThrow();
    expect(policy.approve({ component: 'sandbox' })).toEqual({ component: 'sandbox' });
  });

  it('records typed catalog metrics with approved labels', () => {
    const metrics = new InMemoryMetricsPort();
    const policy = new TagPolicy(
      new Map([
        ['component', new Set(['sandbox', 'webhook', 'workflow'])],
        ['class', new Set(['test', 'build'])],
        ['outcome', new Set(['success', 'failed'])],
      ]),
    );
    const catalog = new MetricCatalog(metrics, policy);
    catalog.incrementCommandStarted('test');
    catalog.recordRunCompleted('success');
    expect(metrics.series.size).toBeGreaterThan(0);
  });
});

describe('C063 timeline + action ledger', () => {
  it('appends monotonic per-run sequence numbers', async () => {
    const timeline = new InMemoryTimelineStore();
    const [a, b] = await timeline.appendMany([
      {
        workflowRunId: 'r1',
        correlationId: 'c',
        eventType: 'workflow.started',
        schemaVersion: 1,
        summary: 'start',
        privacyClass: 'public',
      },
      {
        workflowRunId: 'r1',
        correlationId: 'c',
        eventType: 'step.completed',
        schemaVersion: 1,
        summary: 'step',
      },
    ]);
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
    const read = await timeline.readRange('r1', 1, 10);
    expect(read.length).toBe(1);
  });

  it('records action ledger propose + verified result', async () => {
    const ledger = new InMemoryActionLedger();
    await ledger.propose({ actionId: 'act-1', operationKey: 'op-1', fingerprint: 'fp' });
    const entry = await ledger.transition({
      actionId: 'act-1',
      fingerprint: 'fp',
      result: { status: 'applied', summary: 'ok', evidenceRefs: ['ev-1'] },
      verification: { status: 'verified', evidenceRefs: ['ev-1'] },
    });
    expect(entry.result?.status).toBe('applied');
    expect(entry.verification?.status).toBe('verified');
  });
});

describe('C064 audit/health/diagnostics', () => {
  it('hash-chains immutable audit records and verifies integrity', async () => {
    const writer = new InMemoryAuditWriter();
    const a = await writer.append({
      correlationId: 'c1',
      changeKind: 'privileged',
      summary: 'merge',
      actionId: 'a1',
    });
    await writer.commit(a.id);
    const b = await writer.append({
      correlationId: 'c2',
      changeKind: 'approval',
      summary: 'approve',
    });
    await writer.commit(b.id);
    const verifier = new AuditIntegrityVerifier();
    expect(verifier.verify(await writer.all()).status).toBe('VERIFIED');
    // tamper with a committed record -> mismatch
    const records = await writer.all();
    const tampered = [{ ...records[0], summary: 'tampered' }];
    expect(verifier.verify(tampered).status).toBe('MISMATCH');
  });

  it('readiness depends on critical probes', async () => {
    const health = new HealthService([
      { name: 'db', critical: true, check: async () => ({ ok: true }) },
      { name: 'provider', critical: false, check: async () => ({ ok: false }) },
    ]);
    expect((await health.readiness()).level).toBe('DEGRADED');
    const preflight = new InMemoryPreflightService(health);
    const report = await preflight.preflight();
    expect(report.degraded).toBe(true);
  });

  it('fingerprints and resolves diagnostics', async () => {
    const diag = new InMemoryDiagnosticService();
    const d1 = await diag.record({
      code: 'PROVIDER_TIMEOUT',
      component: 'provider',
      severity: 'high',
      retryability: 'reconcile',
    });
    const d2 = await diag.record({
      code: 'PROVIDER_TIMEOUT',
      component: 'provider',
      severity: 'high',
      retryability: 'reconcile',
    });
    expect(d1.count).toBe(1);
    expect(d2.count).toBe(2);
    await diag.resolve(d2.fingerprint);
    expect(diag.diagnostics.get(d2.fingerprint)!.status).toBe('RESOLVED');
  });
});

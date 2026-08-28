/**
 * C064 §9/§10 — immutable audit records, health, diagnostics.
 *
 * Audit records are hash-chained and immutable (PREPARED -> COMMITTED); a
 * failed required audit write aborts the privileged transaction. Health
 * readiness derives from critical probes; preflight is a fresh run each time;
 * failures are fingerprinted diagnostics (OPEN -> ACKNOWLEDGED -> RESOLVED).
 */
import { createHash } from 'node:crypto';

export interface NewAuditRecord {
  readonly correlationId: string;
  readonly actionId?: string | undefined;
  readonly actorType?: string | undefined;
  readonly actorId?: string | undefined;
  readonly changeKind: 'privileged' | 'approval' | 'policy' | 'provider' | 'result';
  readonly summary: string;
  readonly payloadJson?: string | undefined;
  readonly traceId?: string | undefined;
}

export interface AuditRecord extends NewAuditRecord {
  readonly id: string;
  readonly occurredAtIso: string;
  readonly recordedAtIso: string;
  readonly previousRecordHash?: string | undefined;
  readonly recordHash: string;
  readonly state: 'PREPARED' | 'COMMITTED';
}

export interface AuditWriter {
  append(input: NewAuditRecord): Promise<AuditRecord>;
  commit(id: string): Promise<AuditRecord>;
  all(): Promise<AuditRecord[]>;
}

export class InMemoryAuditWriter implements AuditWriter {
  readonly records: AuditRecord[] = [];
  private lastHash = 'root';

  async append(input: NewAuditRecord): Promise<AuditRecord> {
    const id = `aud:${sha256(input.correlationId + String(this.records.length)).slice(0, 16)}`;
    const record: AuditRecord = {
      ...input,
      id,
      occurredAtIso: new Date().toISOString(),
      recordedAtIso: new Date().toISOString(),
      previousRecordHash: this.lastHash,
      recordHash: chainHash(this.lastHash, input),
      state: 'PREPARED',
    };
    this.records.push(record);
    return record;
  }

  async commit(id: string): Promise<AuditRecord> {
    const index = this.records.findIndex((r) => r.id === id);
    if (index < 0) throw new Error('AUDIT_UNKNOWN');
    const committed: AuditRecord = { ...this.records[index], state: 'COMMITTED' } as AuditRecord;
    this.records[index] = committed;
    this.lastHash = committed.recordHash;
    return committed;
  }

  async all(): Promise<AuditRecord[]> {
    return this.records;
  }
}

export type IntegrityResult = { readonly status: 'VERIFIED' } | { readonly status: 'MISMATCH' };

export class AuditIntegrityVerifier {
  verify(records: readonly AuditRecord[]): IntegrityResult {
    let expect = 'root';
    for (const record of records) {
      if (record.previousRecordHash !== expect) return { status: 'MISMATCH' };
      if (record.recordHash !== chainHash(expect, record)) return { status: 'MISMATCH' };
      expect = record.recordHash;
    }
    return { status: 'VERIFIED' };
  }
}

/** Canonical hash payload: the immutable, evidence-bearing fields only. */
function chainHash(
  prevHash: string,
  input: Omit<NewAuditRecord, 'occurredAtIso' | 'recordedAtIso'>,
): string {
  return sha256(
    `${prevHash}|${JSON.stringify({
      correlationId: input.correlationId,
      actionId: input.actionId ?? '',
      actorType: input.actorType ?? '',
      actorId: input.actorId ?? '',
      changeKind: input.changeKind,
      summary: input.summary,
      payloadJson: input.payloadJson ?? '',
      traceId: input.traceId ?? '',
    })}`,
  );
}

export type HealthLevel = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface HealthProbe {
  readonly name: string;
  readonly critical: boolean;
  check(): Promise<{ readonly ok: boolean }>;
}

export interface Readiness {
  readonly ready: boolean;
  readonly level: HealthLevel;
  readonly probes: Array<{ readonly name: string; readonly ok: boolean }>;
}

export class HealthService {
  constructor(private readonly probes: readonly HealthProbe[]) {}

  liveness(): HealthLevel {
    return 'HEALTHY';
  }

  async readiness(): Promise<Readiness> {
    let level: HealthLevel = 'HEALTHY';
    const results = [];
    for (const probe of this.probes) {
      let ok: boolean;
      try {
        ok = (await probe.check()).ok;
      } catch {
        ok = false;
      }
      results.push({ name: probe.name, ok });
      if (!ok && probe.critical) level = 'UNHEALTHY';
      else if (!ok && level === 'HEALTHY') level = 'DEGRADED';
    }
    return { ready: level === 'HEALTHY', level, probes: results };
  }
}

export interface PreflightReport {
  readonly passed: boolean;
  readonly degraded: boolean;
  readonly failed: string[];
  readonly measureMs: number;
}

export class InMemoryPreflightService {
  constructor(private readonly health: HealthService) {}
  async preflight(): Promise<PreflightReport> {
    const start = Date.now();
    const r = await this.health.readiness();
    const measureMs = Date.now() - start;
    return {
      passed: r.ready,
      degraded: r.level === 'DEGRADED',
      failed: r.probes.filter((p) => !p.ok).map((p) => p.name),
      measureMs,
    };
  }
}

export interface FailureDiagnostic {
  readonly fingerprint: string;
  readonly code: string;
  readonly component: string;
  readonly severity: string;
  readonly retryability: string;
  readonly status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  readonly count: number;
  readonly firstSeenAtIso: string;
  readonly lastSeenAtIso: string;
}

export interface DiagnosticServicePort {
  record(input: {
    code: string;
    component: string;
    severity: string;
    retryability: string;
  }): Promise<FailureDiagnostic>;
  resolve(fingerprint: string): Promise<void>;
}

export class InMemoryDiagnosticService implements DiagnosticServicePort {
  readonly diagnostics = new Map<string, FailureDiagnostic>();
  async record(input: {
    code: string;
    component: string;
    severity: string;
    retryability: string;
  }): Promise<FailureDiagnostic> {
    const fingerprint = `${input.component}:${input.code}`;
    const existing = this.diagnostics.get(fingerprint);
    const now = new Date().toISOString();
    const diagnostic: FailureDiagnostic = {
      fingerprint,
      code: input.code,
      component: input.component,
      severity: input.severity,
      retryability: input.retryability,
      status: 'OPEN',
      count: (existing?.count ?? 0) + 1,
      firstSeenAtIso: existing?.firstSeenAtIso ?? now,
      lastSeenAtIso: now,
    };
    this.diagnostics.set(fingerprint, diagnostic);
    return diagnostic;
  }
  async resolve(fingerprint: string): Promise<void> {
    const existing = this.diagnostics.get(fingerprint);
    if (existing !== undefined)
      this.diagnostics.set(fingerprint, { ...existing, status: 'RESOLVED' });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const auditContractsSchema = {};

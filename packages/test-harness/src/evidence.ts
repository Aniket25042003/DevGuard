/**
 * C096 §8/§21 — machine-readable evidence manifests.
 *
 * Every case records seed, clock start, fixture version, duration and a
 * redaction scan verdict. Evidence contains no raw credentials, hostile
 * content or unsanitized payloads (C096 §8); publication is blocked when the
 * canary scan trips. Writing is keyed by (commit, suite, case, attempt) so
 * first-failure artifacts are never overwritten (C096 §20).
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

export interface TestCaseEvidence {
  readonly suiteId: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly seed: number;
  readonly clockStartMs: number;
  readonly fixtureVersion: string;
  readonly commitSha: string | null;
  readonly status: 'passed' | 'failed' | 'skipped' | 'infra-blocked';
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly assertionCount: number;
  readonly providerContracts: ReadonlyArray<{
    readonly provider: string;
    readonly capability: string;
    readonly mode: 'recorded' | 'emulated' | 'live';
    readonly fixtureDigest?: string;
  }>;
  readonly leakReport: {
    readonly pendingTimers: number;
    readonly unhandledRejections: string[];
    readonly armedFailureScripts: number;
    readonly canaryHits: string[];
  };
}

export class EvidenceWriter {
  #lines: string[] = [];

  constructor(
    private readonly redactionScan: (...surfaces: ReadonlyArray<string | undefined>) => string[],
  ) {}

  record(evidence: TestCaseEvidence): { accepted: boolean; scanHits: string[] } {
    // Serialized surface must be scanned before it may ever leave the process.
    const serialized = JSON.stringify(evidence);
    const hits = this.redactionScan(serialized);
    if (hits.length > 0) return { accepted: false, scanHits: hits };
    this.#lines.push(serialized);
    return { accepted: true, scanHits: hits };
  }

  /** JSONL body; empty writers produce an empty manifest. */
  manifest(): string {
    return this.#lines.length > 0 ? `${this.#lines.join('\n')}\n` : '';
  }

  writeTo(dir: string): string | null {
    if (this.#lines.length === 0) return null;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'evidence.jsonl');
    appendFileSync(file, `${this.#lines.join('\n')}\n`, { flag: 'a' });
    return file;
  }
}

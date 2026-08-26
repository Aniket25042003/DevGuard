/**
 * C095 — Bounded output collection, terminal sanitization, and the
 * artifact scan/quarantine/promotion pipeline.
 *
 * - collectOutput enforces byte/line budgets WHILE consuming the source and
 *   reports explicit truncation with the original counts preserved.
 * - sanitizeTerminal removes ANSI CSI/OSC and control sequences for UI use.
 * - scanAndPromote drives COLLECTED → PENDING_SCAN → SCANNING → SAFE |
 *   QUARANTINED with checksum binding; only exact scanned bytes become SAFE.
 */
import { createHash } from 'node:crypto';
import { makeError } from '@devguard/errors';
import type { ContentBudget } from './paths.js';
import { contentBudget } from './paths.js';

// ---------------------------------------------------------------------------
// Output budget + terminal sanitization
// ---------------------------------------------------------------------------

export interface BoundedOutput {
  /** Safe (budget-respecting) text; truncated when limits hit. */
  readonly text: string;
  readonly truncated: boolean;
  readonly limitKind?: 'bytes' | 'lines' | undefined;
  readonly originalBytes: number;
  readonly originalLines: number;
  readonly digest: string;
}

// Sanitizing terminal escape sequences is this sanitizer's purpose.
// CSI: ESC[ or C1-9b with parameter/intermediate/final bytes.
// OSC: ESC] payload terminated by BEL / ST(ESC \\ / C1 \u009c); unterminated
// OSC payloads run to end-of-text (also removed).
const ANSI_CSI_OSC =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B\\]*(?:\u0007|\u001B\\)?|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)?/g;

/** Strip ANSI/OSC and remaining C0 controls for safe UI projection. */
export function sanitizeTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(ANSI_CSI_OSC, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export async function collectOutput(
  source: AsyncIterable<Uint8Array> | string,
  budgetOverrides: Partial<ContentBudget> = {},
): Promise<BoundedOutput> {
  const budget = contentBudget(budgetOverrides);
  const deadline = Date.now() + budget.deadlineMs;
  const retainCap = Math.min(budget.maxTotalBytes, budget.maxFileBytes);

  const retainedChunks: Buffer[] = [];
  let totalBytes = 0;
  let totalLines = 1;
  let truncated = false;
  let limitKind: 'bytes' | 'lines' | undefined;

  const decoder = new TextDecoder('utf-8');

  /** Count lines in one decoded chunk. */
  const countLines = (text: string): number => {
    let count = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) count += 1;
    }
    return count;
  };

  const processChunk = (chunk: Uint8Array): void => {
    const chunkText = decoder.decode(chunk, { stream: true });
    const projectedTotalLines = totalLines + countLines(chunkText);
    const projectedTotalBytes = totalBytes + chunk.byteLength;

    // Budgets are evaluated BEFORE retention so a violating chunk is never kept.
    if (!truncated) {
      const linesViolated = projectedTotalLines > budget.maxLines;
      const bytesViolated = projectedTotalBytes > retainCap;
      if (linesViolated || bytesViolated) {
        truncated = true;
        limitKind = linesViolated ? 'lines' : 'bytes';
      }
    }

    totalBytes = projectedTotalBytes; // truthful totals regardless of retention
    totalLines = projectedTotalLines;

    if (truncated) return; // count-only mode after any limit was hit

    retainedChunks.push(Buffer.from(chunk));
  };

  if (typeof source === 'string') {
    processChunk(Buffer.from(source, 'utf8'));
  } else {
    for await (const chunk of source) {
      if (Date.now() > deadline) {
        truncated = true;
        limitKind = limitKind ?? 'bytes';
        break;
      }
      processChunk(chunk);
    }
  }

  // Flush the streaming decoder so cut multibyte sequences are resolved
  // (dropped/replaced per WHATWG decoding) rather than corrupting output.
  const text = retainedTextOf(retainedChunks) + decoder.decode();

  return {
    text,
    truncated,
    ...(limitKind !== undefined ? { limitKind } : {}),
    originalBytes: totalBytes,
    originalLines: totalLines,
    digest: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
  };
}

function retainedTextOf(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Artifact scan / promote pipeline
// ---------------------------------------------------------------------------

export type ArtifactScanState =
  'COLLECTED' | 'PENDING_SCAN' | 'SCANNING' | 'SAFE' | 'QUARANTINED' | 'EXPIRED' | 'DELETED';

export interface ArtifactCandidate {
  readonly repositoryId: string;
  readonly workflowRunId: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
}

export interface ArtifactRecordShape {
  readonly artifactId: string;
  readonly repositoryId: string;
  readonly workflowRunId: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly scanState: ArtifactScanState;
  readonly scannerVersion: string;
  readonly quarantineReasonCode?: string | undefined;
  readonly createdAt: string;
}

export interface ContentScannerPort {
  /**
   * Content rules beyond secret scanning (C093). May be unavailable — the
   * pipeline fails closed with bounded retry before quarantining.
   */
  scan(content: Uint8Array): Promise<{ readonly available: boolean; readonly findings: number }>;
}

export class ArtifactPromotionService {
  private readonly maxScanAttempts = 2;

  constructor(
    private readonly publicationGuardLike: {
      scanForLeaks(
        subjectType: string,
        subjectId: string,
        content: string | Uint8Array,
      ): Promise<{
        status: 'clean' | 'findings_present' | 'scanner_unavailable';
        findings: readonly unknown[];
      }>;
    },
    private readonly contentScanner: ContentScannerPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Drive a candidate through the scan pipeline. Only exact scanned bytes
   * (digest-verified) may become SAFE. Scanner outages retry once then fail
   * into quarantine rather than promoting unscanned bytes.
   */
  async scanAndPromote(candidate: ArtifactCandidate): Promise<ArtifactRecordShape> {
    // Private snapshot: caller-owned buffers can mutate mid-scan (TOCTOU).
    const contentSnapshot = Buffer.from(candidate.content);
    const digest = createHash('sha256').update(contentSnapshot).digest('hex');
    const base: ArtifactRecordShape = {
      artifactId: crypto.randomUUID(),
      repositoryId: candidate.repositoryId,
      workflowRunId: candidate.workflowRunId,
      mediaType: candidate.mediaType,
      sizeBytes: candidate.content.byteLength,
      contentDigest: digest,
      scanState: 'PENDING_SCAN',
      scannerVersion: 'dg-content-1',
      createdAt: this.now().toISOString(),
    };

    let attempts = 0;
    for (;;) {
      attempts += 1;

      // Scanner infrastructure failures are normalized into unavailable
      // outcomes (retry within bounds → quarantine); programmer errors still
      // surface as exceptions.
      let leakStatus: 'clean' | 'findings_present' | 'scanner_unavailable';
      try {
        const leakScan = await this.publicationGuardLike.scanForLeaks(
          'artifact',
          base.artifactId,
          contentSnapshot,
        );
        leakStatus = leakScan.status;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        leakStatus = 'scanner_unavailable';
      }
      if (leakStatus === 'scanner_unavailable' && attempts < this.maxScanAttempts) {
        continue; // bounded retry back to PENDING_SCAN semantics
      }
      if (leakStatus === 'findings_present') {
        return this.quarantined(base, 'leak_findings');
      }
      if (leakStatus === 'scanner_unavailable') {
        return this.quarantined(base, 'scanner_unavailable');
      }

      let contentAvailable: boolean;
      let contentFindings: number;
      try {
        const contentScan = await this.contentScanner.scan(contentSnapshot);
        contentAvailable = contentScan.available;
        contentFindings = contentScan.findings;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // Infrastructure failure normalizes to an unavailable outcome.
        contentAvailable = false;
        contentFindings = 0;
      }
      if (!contentAvailable && attempts < this.maxScanAttempts) continue;
      if (!contentAvailable) return this.quarantined(base, 'content_scanner_unavailable');
      if (contentFindings > 0) return this.quarantined(base, 'content_findings');

      // Digest re-verification immediately before promotion against the
      // PRIVATE snapshot — the only bytes ever scanned.
      const verifyDigest = createHash('sha256').update(contentSnapshot).digest('hex');
      if (verifyDigest !== base.contentDigest) {
        throw makeError('PUBLICATION_BLOCKED', {
          details: { reasonCode: 'digest_mismatch', findingCount: 0 },
          cause: new Error('bytes changed during scan'),
        });
      }
      return { ...base, scanState: 'SAFE' };
    }
  }

  private quarantined(base: ArtifactRecordShape, reasonCode: string): ArtifactRecordShape {
    return { ...base, scanState: 'QUARANTINED', quarantineReasonCode: reasonCode };
  }
}

/** Fresh authorization on every read; lifecycle gates applied after authz. */
export function authorizeArtifactRead(
  record: Pick<ArtifactRecordShape, 'repositoryId' | 'scanState'> & {
    readonly retentionExpiresAt?: string | undefined;
  },
  principalRepositoryAccess: { readonly allowed: boolean; readonly repositoryId: string },
): void {
  if (
    !principalRepositoryAccess.allowed ||
    principalRepositoryAccess.repositoryId !== record.repositoryId
  ) {
    throw makeError('ARTIFACT_ACCESS_DENIED', {
      cause: new Error('repository authorization failed'),
    });
  }
  if (record.scanState !== 'SAFE') {
    throw makeError('ARTIFACT_NOT_SAFE', { cause: new Error(`state ${record.scanState}`) });
  }
  if (record.retentionExpiresAt !== undefined) {
    const expiryMs = Date.parse(record.retentionExpiresAt);
    // Malformed persisted lifecycle data fails closed rather than granting.
    if (Number.isNaN(expiryMs)) {
      throw makeError('ARTIFACT_EXPIRED', { cause: new Error('invalid retention timestamp') });
    }
    if (expiryMs <= Date.now()) {
      throw makeError('ARTIFACT_EXPIRED', { cause: new Error('retention elapsed') });
    }
  }
}

/**
 * C093 — Leak scanning and the digest-bound publication guard.
 *
 * - `scanForLeaks(subject)` computes the subject digest itself and runs the
 *   detector set; findings carry keyed-HMAC fingerprints and bounded ranges,
 *   never raw matches.
 * - `PublicationGuard.assertPublishable(result, expectedDigest)` binds the
 *   scan to the EXACT bytes being published (TOCTOU defense) and fails closed
 *   on findings, scanner unavailability, or digest mismatch.
 */
import { createHash } from 'node:crypto';
import { makeError } from '@devguard/errors';
import { type SensitiveDataGuard } from '../redaction/guard.js';

export type ScanStatus = 'clean' | 'findings_present' | 'scanner_unavailable';

export interface LeakFinding {
  readonly detectorClass: string;
  /** Keyed HMAC fingerprint — never the raw match. */
  readonly fingerprintHmac: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface LeakScanResult {
  readonly subjectType: string;
  readonly subjectId: string;
  /** Digest over the exact scanned bytes; publication must match it. */
  readonly subjectDigest: string;
  readonly scannerVersion: string;
  readonly status: ScanStatus;
  readonly findings: readonly LeakFinding[];
}

const SCANNER_VERSION = 'dg-leak-1';

export class PublicationGuard {
  private readonly guard: SensitiveDataGuard;
  /** Injectable failure switch: models scanner outages (fail closed). */
  private available = true;

  constructor(guard: SensitiveDataGuard) {
    this.guard = guard;
  }

  setScannerAvailability(available: boolean): void {
    this.available = available;
  }

  async scanForLeaks(
    subjectType: string,
    subjectId: string,
    content: string | Uint8Array,
  ): Promise<LeakScanResult> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const subjectDigest = createHash('sha256').update(bytes).digest('hex');
    if (!this.available) {
      // Fail CLOSED: an unscannable subject is unpublishable.
      return {
        subjectType,
        subjectId,
        subjectDigest,
        scannerVersion: SCANNER_VERSION,
        status: 'scanner_unavailable',
        findings: [],
      };
    }
    const text = bytes.toString('utf8');
    const findings: LeakFinding[] = [];
    for (const [candidate] of text.matchAll(/[A-Za-z0-9_\-./+=]{4,}/g)) {
      if (this.guard.matchesExactSecret(candidate)) {
        const index = text.indexOf(candidate);
        findings.push({
          detectorClass: 'exact_value',
          fingerprintHmac: this.guard.fingerprintOf(candidate),
          rangeStart: Math.max(0, index),
          rangeEnd: index + candidate.length,
          confidence: 'high',
        });
      }
    }
    const patternFindings = collectPatternFindings(text, this.guard);
    findings.push(...patternFindings);
    return {
      subjectType,
      subjectId,
      subjectDigest,
      scannerVersion: SCANNER_VERSION,
      status: findings.length > 0 ? 'findings_present' : 'clean',
      findings: findings.slice(0, 100),
    };
  }

  /**
   * Assert a fresh, matching, clean scan for the exact bytes about to be
   * published. Any mismatch blocks with PUBLICATION_BLOCKED.
   */
  assertPublishable(result: LeakScanResult, exactBytes: string | Uint8Array): void {
    const actualDigest =
      typeof exactBytes === 'string'
        ? createHash('sha256').update(Buffer.from(exactBytes, 'utf8')).digest('hex')
        : createHash('sha256').update(Buffer.from(exactBytes)).digest('hex');

    if (result.status === 'scanner_unavailable') {
      throw makeError('PUBLICATION_BLOCKED', {
        details: { reasonCode: 'scanner_unavailable', findingCount: 0 },
        cause: new Error('scanner unavailable'),
      });
    }
    if (result.subjectDigest !== actualDigest) {
      throw makeError('PUBLICATION_BLOCKED', {
        details: { reasonCode: 'digest_mismatch', findingCount: 0 },
        cause: new Error('scan does not cover these bytes'),
      });
    }
    if (result.status === 'findings_present' || result.findings.length > 0) {
      throw makeError('PUBLICATION_BLOCKED', {
        details: { reasonCode: 'findings_present', findingCount: result.findings.length },
        cause: new Error(`${result.findings.length} finding(s)`),
      });
    }
  }
}

function collectPatternFindings(text: string, guard: SensitiveDataGuard): LeakFinding[] {
  const detectors: ReadonlyArray<{ id: string; pattern: RegExp; confidence: 'high' | 'medium' }> = [
    { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, confidence: 'high' },
    { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 'high' },
    { id: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, confidence: 'high' },
    {
      id: 'jwt',
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
      confidence: 'medium',
    },
  ];
  const findings: LeakFinding[] = [];
  for (const detector of detectors) {
    for (const match of text.matchAll(detector.pattern)) {
      const matched = match[0] ?? '';
      const index = match.index ?? 0;
      if (guard.matchesExactSecret(matched)) continue; // already covered by exact_value
      findings.push({
        detectorClass: detector.id,
        fingerprintHmac: guard.fingerprintOf(matched),
        rangeStart: index,
        rangeEnd: index + matched.length,
        confidence: detector.confidence,
      });
      if (findings.length >= 50) return findings;
    }
  }
  return findings;
}

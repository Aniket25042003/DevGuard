/**
 * C093 — Leak scanning and the digest-bound publication guard.
 *
 * - `scanForLeaks(subject)` computes the subject digest itself and runs the
 *   SHARED detector registry plus exact-value matching; findings carry keyed
 *   HMAC fingerprints and bounded ranges, never raw matches.
 * - `PublicationGuard.assertPublishable(result, expectedDigest)` binds the
 *   scan to the EXACT bytes being published (TOCTOU defense) and fails closed
 *   on findings, scanner unavailability, or digest mismatch.
 */
import { createHash } from 'node:crypto';
import { makeError } from '@devguard/errors';
import { DETECTOR_REGISTRY } from '../redaction/detectors.js';
import type { SensitiveDataGuard } from '../redaction/guard.js';

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

const SCANNER_VERSION = 'dg-leak-2';

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

    // Exact registered secrets — full alphabet, allowlist-proof, highest confidence.
    for (const match of this.guard.findExactMatches(text)) {
      findings.push({
        detectorClass: 'exact_value',
        fingerprintHmac: this.guard.fingerprintOf(match.value),
        rangeStart: match.start,
        rangeEnd: match.end,
        confidence: 'high',
      });
      if (findings.length >= 100) break;
    }

    // Shared detector registry — same classes as redaction.
    if (findings.length < 100) {
      for (const detector of DETECTOR_REGISTRY) {
        for (const match of text.matchAll(detector.pattern)) {
          const matched = match[0] ?? '';
          const index = match.index ?? 0;
          // Skip ranges already covered by exact matches (dedupe by position).
          if (findings.some((finding) => index >= finding.rangeStart && index < finding.rangeEnd)) {
            continue;
          }
          findings.push({
            detectorClass: detector.id,
            fingerprintHmac: this.guard.fingerprintOf(matched),
            rangeStart: index,
            rangeEnd: index + matched.length,
            confidence: detector.confidence,
          });
          if (findings.length >= 100) break;
        }
        if (findings.length >= 100) break;
      }
    }

    return {
      subjectType,
      subjectId,
      subjectDigest,
      scannerVersion: SCANNER_VERSION,
      status: findings.length > 0 ? 'findings_present' : 'clean',
      findings,
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

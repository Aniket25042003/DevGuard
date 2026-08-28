/**
 * C042 §12/§17 — bounded, normalized, redacted output ingestion.
 *
 * Output is untrusted: each chunk is UTF-8 normalized, terminal controls/ANSI
 * stripped, and secret values redacted BEFORE persistence; bytes are bounded and
 * tracked as a checksummed `OutputRef`. Truncation is explicit and never hides
 * an incomplete/unsafe final state.
 */
import { createHash } from 'node:crypto';
import { redactValue } from '../redact.js';
import type { OutputRef } from './contracts.js';

export interface OutputStreamState {
  readonly outputId: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly checksum: string;
  readonly chunks: number;
}

export class OutputNormalizer {
  #bytes = 0;
  #chunkCount = 0;
  #truncated = false;
  #digest = createHash('sha256');
  #carry = '';

  private longestSecret(): number {
    return this.secretValues.reduce((max, secret) => Math.max(max, Buffer.byteLength(secret, 'utf8')), 0);
  }

  private redact(text: string): string {
    return this.secretValues.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), text);
  }

  private accept(text: string): number {
    const bytes = Buffer.from(text, 'utf8');
    const accepted = bytes.subarray(0, Math.max(0, this.maxBytes - this.#bytes));
    const safe = accepted.toString('utf8');
    this.#digest.update(safe, 'utf8');
    this.#bytes += Buffer.byteLength(safe, 'utf8');
    return Buffer.byteLength(safe, 'utf8');
  }

  #flush(final: boolean): number {
    const redacted = this.redact(this.#carry);
    const keep = final ? 0 : Math.max(0, this.longestSecret() - 1);
    const boundary = Array.from(redacted).slice(0, Math.max(0, Array.from(redacted).length - keep)).join('');
    this.#carry = final ? '' : Array.from(redacted).slice(Math.max(0, Array.from(redacted).length - keep)).join('');
    return this.accept(boundary);
  }


  constructor(
    private readonly outputId: string,
    private readonly maxBytes: number,
    private readonly secretValues: readonly string[],
  ) {}

  ingest(chunk: string | Uint8Array): {
    readonly acceptedBytes: number;
    readonly truncated: boolean;
  } {
    const raw = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    // Normalize encoding and strip terminal control/ANSI escapes.
    const normalized = this.stripControls(raw);
    this.#carry += normalized;
    const accepted = this.#flush(false);
    this.#chunkCount += 1;
    if (accepted < Buffer.byteLength(normalized, 'utf8')) this.#truncated = true;
    return { acceptedBytes: accepted, truncated: this.#truncated };
  }

  finalize(): OutputRef {
    if (this.#carry) this.#flush(true);
    return {
      outputId: this.outputId,
      bytes: this.#bytes,
      truncated: this.#truncated,
      checksum: this.#digest.digest('hex'),
      chunks: this.#chunkCount,
    };
  }

  state(): OutputStreamState {
    return {
      outputId: this.outputId,
      bytes: this.#bytes,
      truncated: this.#truncated,
      checksum: this.#digest.copy().digest('hex'),
      chunks: this.#chunkCount,
    };
  }

  private stripControls(text: string): string {
    // ANSI escape sequences (`ESC [ params letter`) — ESC is built without a
    // control-char literal so ESLint no-control-regex stays satisfied.
    const ansiRe = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');
    const noAnsi = text.replace(ansiRe, '');
    return Array.from(noAnsi)
      .filter((ch) => ch >= '\u0020' || ch === '\n' || ch === '\t' || ch === '\r')
      .join('');
  }
}

export { redactValue };

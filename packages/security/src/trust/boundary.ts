/**
 * C092 — Content boundary encoding, minimization, and derived provenance.
 *
 * Invariants:
 * - Untrusted content is QUOTED between stable delimiters carrying its
 *   provenance id, source kind, and digest.
 * - Embedded delimiter sequences inside content are neutralized so the
 *   closing tag cannot be forged from within the quoted payload.
 * - Control characters and bidirectional/zero-width Unicode are stripped
 *   BEFORE display/context inclusion; the original digest evidence remains
 *   attached to the envelope (never silently rewritten).
 */
import { sha256Hex } from './provenance.js';
import type { ProvenanceEnvelopeShape } from './provenance.js';

const BIDI_AND_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Stripping control characters from hostile content is this module's purpose;
// the rule targets accidental regexes, not sanitizers.
// eslint-disable-next-line no-control-regex
const C0_CONTROL_EXCEPT_TAB_LF = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function openBoundary(envelope: ProvenanceEnvelopeShape): string {
  return `<untrusted_data id="${envelope.id}" source="${envelope.sourceKind}" digest="${envelope.digest}">`;
}

export function closeBoundary(): string {
  return '</untrusted_data>';
}

/** Neutralize closing-tag forgeries and hostile invisible/control characters. */
export function sanitizeQuotedContent(content: string): {
  readonly safe: string;
  readonly strippedCount: number;
} {
  const before = content;
  let safe = content
    .replaceAll('</untrusted_data>', '<\\/untrusted_data>')
    .replaceAll(BIDI_AND_INVISIBLE, '')
    .replaceAll(C0_CONTROL_EXCEPT_TAB_LF, '');
  // Cap runaway blank-line floods without changing semantics.
  safe = safe.replace(/\n{5,}/g, '\n\n\n');
  const strippedCount = before.length - safe.length;
  return { safe, strippedCount };
}

/**
 * Encode one untrusted item into labeled, bounded context text. The returned
 * `encodedDigest` covers the EXACT bytes placed in context so downstream
 * consumers can verify nothing was altered after trust evaluation.
 */
export function encodeUntrustedSection(
  envelope: ProvenanceEnvelopeShape,
  rawContent: string,
): { readonly text: string; readonly encodedDigest: string; readonly strippedCount: number } {
  const { safe, strippedCount } = sanitizeQuotedContent(rawContent);
  const text = `${openBoundary(envelope)}\n${safe}\n${closeBoundary()}`;
  return { text, encodedDigest: sha256Hex(text), strippedCount };
}

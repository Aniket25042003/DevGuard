/**
 * C045 §8/§23.1 — canonical JSON serialization and content digests.
 *
 * Definitions, skill assets, snapshots and bundles are bound by SHA-256
 * digests over a deterministic canonical representation (the same RFC 8785
 * subset the approvals package implements, restated here because the
 * application boundary forbids importing @devguard/approvals):
 *   - object keys sorted by UTF-16 code units
 *   - strings Unicode NFC; ECMA-404 escaping; lone surrogates REJECTED
 *   - numbers in ES6 Number::toString form; non-finite rejected
 *   - `undefined` is OMITTED (absent optional fields never become null);
 *     `null` is emitted only where a schema explicitly allows it
 *   - arrays preserve order; set-like fields are sorted upstream
 *
 * Digest immutability invariant (plan §9/§20): the identity of a registered
 * definition/skill is `(id, version, digest)`; any content mutation changes
 * the digest, so a conflicting re-registration is detectably fatal.
 */
import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** ECMA-404 string serialization with RFC 8785 escaping (fail closed on lone surrogates). */
function serializeString(input: string): string {
  const normalized = input.normalize('NFC');
  let out = '"';
  for (const char of normalized) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      throw new CanonicalizationError('cannot serialize a string with no code points');
    }
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, '0')}`;
        } else if (code >= 0xd800 && code <= 0xdfff) {
          // Lone surrogates are not valid I-JSON; reject instead of best-effort.
          throw new CanonicalizationError('lone surrogate in string');
        } else {
          out += char;
        }
    }
  }
  return `${out}"`;
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError('non-finite number');
  }
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/** Canonicalize a JSON-compatible value to a deterministic string. */
export function canonicalize(value: unknown, _depth = 0): string {
  if (_depth > 512) {
    throw new CanonicalizationError('nesting depth exceeded');
  }
  if (value === null) return 'null';
  if (typeof value === 'string') return serializeString(value);
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined) {
    // Canonicalizing a bare undefined is ambiguous; callers omit undefined
    // object members BEFORE reaching here.
    throw new CanonicalizationError('undefined value');
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalize(element, _depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new CanonicalizationError('non-plain object');
    }
    const keys = Object.keys(value).sort();
    const members: string[] = [];
    for (const key of keys) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue; // omitted optional fields are ABSENT
      members.push(`${serializeString(key)}:${canonicalize(member, _depth + 1)}`);
    }
    return `{${members.join(',')}}`;
  }
  throw new CanonicalizationError(`unsupported value type: ${typeof value}`);
}

/** SHA-256 hex digest over canonical JSON of a value. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Deterministic content digest: sha256(canonicalize(value)). */
export function digestJson(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/**
 * C031 §7/§10 — canonical JSON serialization and fingerprinting.
 *
 * Open decision (C031 §28): RFC 8785 JCS implementation selection. Rather
 * than pull an unpinned dependency, this implements the EXACT deterministic
 * subset the plan's normalization rules demand (C031 §10):
 *   - object keys sorted by UTF-16 code units (JCS ordering)
 *   - strings Unicode NFC, minimal JSON escaping per RFC 8785 (ECMA-404)
 *   - numbers in ES6 Number::toString form; non-finite rejected outright
 *   - `undefined`/functions rejected; omitted optional fields are ABSENT,
 *     never null; `null` only where a schema explicitly allows it
 *   - arrays keep order (ordered operations); set-like fields sorted upstream
 *
 * Known-limitation note: full JCS also specifies I-JSON string escaping for
 * lone surrogates — inputs containing lone surrogates are REJECTED here
 * (fail closed) rather than best-effort serialized. Golden vectors cover
 * every rule; a dedicated maintained library can be swapped behind this
 * module's single function without touching callers.
 */
import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** ECMA-404 / RFC 8785 string serialization. */
function serializeString(input: string): string {
  // NFC normalization first (C031 §10).
  const normalized = input.normalize('NFC');
  let out = '"';
  for (const char of normalized) {
    const code = char.codePointAt(0)!;
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
          // Lone surrogates are unrepresentable in I-JSON: fail closed.
          throw new CanonicalizationError('lone surrogate in string is not canonicalizable');
        } else {
          out += char;
        }
    }
  }
  return `${out}"`;
}

/** ES6 Number::toString serialization per RFC 8785 §3.2.2.3. */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value))
    throw new CanonicalizationError('non-finite numbers cannot be canonicalized');
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function canonicalize(value: unknown): string {
  const walk = (node: unknown): string => {
    if (node === null) return 'null';
    if (node === undefined || typeof node === 'function' || typeof node === 'bigint') {
      throw new CanonicalizationError(
        `value of type '${typeof node}' is not allowed in canonical JSON`,
      );
    }
    if (typeof node === 'string') return serializeString(node);
    if (typeof node === 'number') return serializeNumber(node);
    if (typeof node === 'boolean') return node ? 'true' : 'false';
    if (Array.isArray(node)) return `[${node.map(walk).join(',')}]`;
    if (isPlainObject(node)) {
      // JCS key order: UTF-16 code unit sort of the RAW key.
      const keys = Object.keys(node).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts: string[] = [];
      for (const key of keys) {
        const child = node[key];
        if (child === undefined) continue; // absent, never null
        parts.push(`${serializeString(key)}:${walk(child)}`);
      }
      return `{${parts.join(',')}}`;
    }
    if (node instanceof Date) {
      throw new CanonicalizationError(
        'Date objects must be pre-converted to ISO strings by the caller',
      );
    }
    throw new CanonicalizationError(`unsupported value type '${describe(node)}'`);
  };
  return walk(value);
}

function describe(value: unknown): string {
  if (value instanceof Date) return 'Date';
  return typeof value;
}

/** sha256, lowercase hex, over UTF-8 bytes of the canonical JSON. */
export function sha256Hex(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/** Convenience: canonicalize + digest in one step. */
export function fingerprint(value: unknown): {
  readonly canonicalJson: string;
  readonly hash: string;
} {
  const canonicalJson = canonicalize(value);
  return { canonicalJson, hash: sha256Hex(canonicalJson) };
}

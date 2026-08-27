/**
 * C023 §2/§5/§17 — safe YAML/JSON decoding boundary.
 *
 * Produces plain JavaScript values only. Rejected deterministically:
 * - YAML anchors/aliases (alias bombs), merge keys, custom tags
 * - duplicate mapping keys at any depth
 * - non-finite numbers, non-string keys, timestamps-as-objects
 * - prototype-pollution keys anywhere in the document
 * - documents beyond byte/depth/size caps
 *
 * Raw parser values, YAML nodes and library types stop here: downstream sees
 * JSON-compatible structures exclusively (C023 §6 architectural position).
 */
import { parseDocument, visit } from 'yaml';
import type { SourceLocation } from '../schema/diagnostics.js';
import { PolicyValidationReport } from '../schema/diagnostics.js';

/** C023 §17 input caps. A deployment may tighten but not exceed these. */
export const DECODE_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxNodes: 8192,
  maxScalarLength: 4096,
  maxCollections: 512,
} as const);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface DecodedDocument {
  readonly value: unknown;
  /** Format provenance recorded for parity tests; never persisted as authority. */
  readonly format: 'yaml' | 'json';
}

export class PolicyDecoder {
  #report: PolicyValidationReport;
  #nodeBudget = DECODE_LIMITS.maxNodes;

  constructor(report = new PolicyValidationReport()) {
    this.#report = report;
  }

  /**
   * Decode untrusted bytes to a JSON-compatible document or record diagnostics.
   * Returns undefined when decoding failed.
   */
  decode(source: Uint8Array | string, formatHint?: 'yaml' | 'json'): DecodedDocument | undefined {
    let text: string;
    if (typeof source === 'string') text = source;
    else {
      if (source.byteLength > DECODE_LIMITS.maxBytes) {
        this.#report.add({ code: 'POLICY_TOO_LARGE', path: '', message: `policy exceeds ${DECODE_LIMITS.maxBytes} bytes` });
        return undefined;
      }
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); }
      catch { this.#report.add({ code: 'POLICY_SYNTAX_INVALID', path: '', message: 'invalid UTF-8' }); return undefined; }
    }
    if (Buffer.byteLength(text, 'utf8') > DECODE_LIMITS.maxBytes) {
      this.#report.add({
        code: 'POLICY_TOO_LARGE',
        path: '',
        message: `policy exceeds ${DECODE_LIMITS.maxBytes} bytes`,
      });
      return undefined;
    }
    const isJson = formatHint === 'json' || (formatHint !== 'yaml' && /^\s*[{}[]/.test(text));
    try {
      const raw = isJson ? JSON.parse(text) : this.#parseYamlSafely(text);
      if (!isPlainValue(raw)) {
        this.#report.add({
          code: 'POLICY_SCHEMA_INVALID',
          path: '',
          message: 'document root must be an object',
        });
        return undefined;
      }
      const value = this.#sanitize(raw, '$', 0);
      return value === undefined && !this.#report.ok
        ? undefined
        : { value, format: isJson ? 'json' : 'yaml' };
    } catch (error) {
      const loc = locationOf(error);
      this.#report.add({
        code: 'POLICY_SYNTAX_INVALID',
        path: '',
        message: String((error as Error)?.message ?? 'unparseable document'),
        ...(loc ? { location: loc } : {}),
      });
      return undefined;
    }
  }

  get diagnostics(): PolicyValidationReport {
    return this.#report;
  }

  /**
   * Parse YAML through its document/AST form so hostile node features are
   * detected regardless of library defaults (they resolve aliases silently):
   * anchors, aliases (alias bombs), merge keys and explicit tags are all
   * rejected (C023 §5). Core 1.2 schema only.
   */
  #parseYamlSafely(text: string): unknown {
    const doc = parseDocument(text, { version: '1.2' });
    let hostile: string | undefined;
    const reject = (reason: string): symbol | number => {
      hostile ??= reason;
      return visit.BREAK;
    };
    visit(doc, {
      Alias: () => reject('YAML aliases are forbidden'),
      Scalar: (_k, node) =>
        node.anchor || node.tag ? reject('YAML anchors/tags are forbidden') : undefined,
      Map: (_k, node) =>
        node.anchor || node.tag ? reject('YAML anchors/tags are forbidden') : undefined,
      Seq: (_k, node) =>
        node.anchor || node.tag ? reject('YAML anchors/tags are forbidden') : undefined,
      Pair: (_k, pair) => {
        const keyValue = (pair.key as { value?: unknown } | undefined)?.value ?? pair.key;
        if (String(keyValue) === '<<') return reject('YAML merge keys are forbidden');
        const key = pair.key as { tag?: string } | undefined;
        if (key && typeof key === 'object' && key.tag)
          return reject('YAML anchors/tags are forbidden');
        return undefined;
      },
    });
    if (hostile) throw new TypeError(hostile);
    if (doc.errors.length > 0) throw doc.errors[0];
    // Warnings (e.g. unresolved custom tags resolving to strings) also fail:
    // unresolved evidence means the document was not plain core-schema YAML.
    if (doc.warnings.length > 0) {
      throw new TypeError(
        `unresolved or non-core YAML features: ${String(doc.warnings[0]?.message ?? '')}`,
      );
    }
    return doc.toJS();
  }

  /** Recursively verify structure and enforce every decoder invariant. */
  #sanitize(value: unknown, path: string, depth: number): unknown {
    if (this.#nodeBudget <= 0) {
      this.#report.add({
        code: 'POLICY_TOO_LARGE',
        path,
        message: `document exceeds ${DECODE_LIMITS.maxNodes} nodes`,
      });
      return undefined;
    }
    this.#nodeBudget -= 1;

    if (depth > DECODE_LIMITS.maxDepth) {
      this.#report.add({
        code: 'POLICY_TOO_LARGE',
        path,
        message: `nesting deeper than ${DECODE_LIMITS.maxDepth}`,
      });
      return undefined;
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      if (typeof value === 'string') {
        const normalized = value.normalize('NFC');
        if (normalized.length > DECODE_LIMITS.maxScalarLength) {
          this.#report.add({
            code: 'POLICY_TOO_LARGE',
            path,
            message: `scalar longer than ${DECODE_LIMITS.maxScalarLength}`,
          });
          return undefined;
        }
        return normalized;
      }
      return typeof value === 'number' ? normalizeNumber(value, path, this.#report) : value;
    }

    if (Array.isArray(value)) {
      if (value.length > DECODE_LIMITS.maxCollections) {
        this.#report.add({
          code: 'POLICY_TOO_LARGE',
          path,
          message: `array larger than ${DECODE_LIMITS.maxCollections}`,
        });
        return undefined;
      }
      const out: unknown[] = [];
      let failed = false;
      for (let i = 0; i < value.length; i++) {
        const sanitized = this.#sanitize(value[i], `${path}[${i}]`, depth + 1);
        if (sanitized === undefined) {
          failed = true;
          continue;
        }
        out.push(sanitized);
      }
      return failed && !this.#report.ok ? undefined : out;
    }

    if (isRecordLike(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > DECODE_LIMITS.maxCollections) {
        this.#report.add({
          code: 'POLICY_TOO_LARGE',
          path,
          message: `object larger than ${DECODE_LIMITS.maxCollections}`,
        });
        return undefined;
      }
      const seenKeys = new Set<string>();
      const out: Record<string, unknown> = {};
      let failed = false;
      for (const [key, child] of entries) {
        if (typeof key !== 'string') {
          // yaml may hand back non-string keys with default settings.
          this.#report.add({
            code: 'POLICY_SCHEMA_INVALID',
            path,
            message: 'mapping keys must be strings',
          });
          failed = true;
          continue;
        }
        if (DANGEROUS_KEYS.has(key)) {
          this.#report.add({
            code: 'POLICY_SCHEMA_INVALID',
            path: `${path}.${key}`,
            message: `key '${key}' is forbidden`,
          });
          failed = true;
          continue;
        }
        if (seenKeys.has(key)) {
          this.#report.add({
            code: 'POLICY_SYNTAX_INVALID',
            path: `${path}.${key}`,
            message: `duplicate key '${key}'`,
          });
          failed = true;
          continue;
        }
        seenKeys.add(key);
        const sanitized = this.#sanitize(child, `${path}.${key}`, depth + 1);
        if (sanitized === undefined) {
          failed = true;
          continue;
        }
        out[key] = sanitized;
      }
      return failed && !this.#report.ok ? undefined : out;
    }

    this.#report.add({
      code: 'POLICY_SCHEMA_INVALID',
      path,
      message: `unsupported value type '${describeType(value)}'`,
    });
    return undefined;
  }
}

function describeType(value: unknown): string {
  if (value instanceof Date) return 'timestamp';
  if (typeof value === 'bigint') return 'bigint';
  if (value === null) return 'null';
  return typeof value;
}

function isPlainValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return value === undefined || ['string', 'boolean', 'number'].includes(typeof value)
      ? true
      : false;
  }
  return true;
}

function isRecordLike(value: unknown): boolean {
  if (value instanceof Date || value === null) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function normalizeNumber(value: number, path: string, report: PolicyValidationReport): number {
  if (!Number.isFinite(value)) {
    report.add({ code: 'POLICY_SCHEMA_INVALID', path, message: 'numbers must be finite' });
    return Number.NaN;
  }
  return value;
}

function locationOf(error: unknown): SourceLocation | undefined {
  const candidate = error as { linePos?: Array<{ line: number; col: number }> };
  const first = candidate?.linePos?.[0];
  return first ? { line: first.line, column: first.col } : undefined;
}

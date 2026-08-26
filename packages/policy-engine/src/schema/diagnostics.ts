/**
 * C023 §11/§18 — stable, safe diagnostics with source locations.
 *
 * Diagnostics carry stable codes and optional line/column data; they never
 * embed parser stack traces or raw oversized excerpts. Counts are capped so a
 * hostile document cannot flood reports (C023 §17).
 */
import type { DevGuardError } from '@devguard/errors';

export const MAX_DIAGNOSTICS = 25;

export type PolicyDiagnosticCode =
  | 'POLICY_SYNTAX_INVALID'
  | 'POLICY_SCHEMA_INVALID'
  | 'POLICY_REFERENCE_UNKNOWN'
  | 'POLICY_CONFLICT'
  | 'POLICY_TOO_LARGE';

export interface SourceLocation {
  readonly line?: number;
  readonly column?: number;
}

export interface PolicyDiagnostic {
  readonly code: PolicyDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly location?: SourceLocation;
}

export class PolicyValidationReport {
  #diagnostics: PolicyDiagnostic[] = [];

  static get maxDiagnostics(): number {
    return MAX_DIAGNOSTICS;
  }

  add(diagnostic: PolicyDiagnostic): void {
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) return;
    this.#diagnostics.push({
      ...diagnostic,
      message:
        diagnostic.message.length > 300
          ? `${diagnostic.message.slice(0, 297)}…`
          : diagnostic.message,
    });
  }

  addAll(diagnostics: readonly PolicyDiagnostic[]): void {
    for (const diagnostic of diagnostics) this.add(diagnostic);
  }

  get items(): readonly PolicyDiagnostic[] {
    return [...this.#diagnostics];
  }

  get ok(): boolean {
    return this.#diagnostics.length === 0;
  }

  get worstCode(): PolicyDiagnosticCode {
    const order: PolicyDiagnosticCode[] = [
      'POLICY_TOO_LARGE',
      'POLICY_SYNTAX_INVALID',
      'POLICY_SCHEMA_INVALID',
      'POLICY_CONFLICT',
      'POLICY_REFERENCE_UNKNOWN',
    ];
    for (const code of order) {
      if (this.#diagnostics.some((d) => d.code === code)) return code;
    }
    return this.#diagnostics[0]?.code ?? 'POLICY_SCHEMA_INVALID';
  }
}

/** Map a diagnostic to its C023 §11 HTTP status contract. */
export function httpStatusFor(code: PolicyDiagnosticCode): number {
  switch (code) {
    case 'POLICY_SYNTAX_INVALID':
      return 400;
    case 'POLICY_CONFLICT':
      return 409;
    case 'POLICY_TOO_LARGE':
      return 413;
    case 'POLICY_SCHEMA_INVALID':
    case 'POLICY_REFERENCE_UNKNOWN':
    default:
      return 422;
  }
}

/** Convert registered DevGuard errors raised by pipeline stages into diagnostics. */
export function errorToDiagnostic(error: unknown, path = ''): PolicyDiagnostic {
  const guard = error as Partial<DevGuardError> & { message?: string };
  const isPolicyCode =
    typeof guard?.code === 'string' &&
    [
      'POLICY_SYNTAX_INVALID',
      'POLICY_SCHEMA_INVALID',
      'POLICY_REFERENCE_UNKNOWN',
      'POLICY_CONFLICT',
      'POLICY_TOO_LARGE',
    ].includes(guard.code);
  return {
    code: isPolicyCode ? (guard.code as PolicyDiagnosticCode) : 'POLICY_SYNTAX_INVALID',
    path,
    message: String(guard?.message ?? 'policy rejected'),
  };
}

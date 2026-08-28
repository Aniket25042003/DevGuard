/**
 * C016 §12/§22 — deterministic directive classifier.
 *
 * Classifies a bounded instruction fragment into a directive category. The
 * classifier is heuristic but deterministic: it never interprets text as
 * executable authority and never decides authorization — those decisions live
 * in the service. Text is normalized (case-folded, control char collapsed)
 * before matching and is bounded; over-classification toward a safety/authority
 * category is intentional (fail closed).
 */
import type { DirectiveCategory, RejectionReasonCode } from './contracts.js';

export interface DirectiveClassification {
  readonly category: DirectiveCategory;
  /** True when the directive attempts to grant/expand tool/approval authority. */
  readonly grantsAuthority: boolean;
  /** True when the directive attempts to weaken a safety/validation obligation. */
  readonly overridesSafety: boolean;
}

const AUTHORITY_GRANT_PATTERNS = [
  /\byou (may|can|are (?:allowed|free|permitted) to|should have (?:full )?autonomy)\b/,
  /\bgrant(?:ed|s)? (?:you )?(permission|access|authority)\b/,
  /\b(?:full )?autonomy\b/,
  /\byou are the (?:admin|owner|root)\b/,
  /\bauthoriz(?:e|ed|ing)\b/,
];

const SAFETY_PATTERNS = [
  /\b(?:disable|ignore|bypass|skip|turn ?off|override) (?:the )?safety\b/,
  /\b(?:do not|never|without) (?:run|follow) (?:any )?safety\b/,
  /\bmute (?:the )?safety (?:check|gate)s?\b/,
];

const SECRET_PATTERNS = [
  /\b(?:api[ -]?key|password|passwd|secret|token|credential|private[ -]?key|bearer)\b/,
  /\b(?:exfiltrate|send|upload|post|reveal|print|echo|dump|leak) (?:the )?(?:api[ -]?key|password|token|secret|credential)s?\b/,
  /\b(?:send|upload|post|push) (?:to|it to|this to)\b/,
];

const TOOL_PATTERNS = [
  /\b(?:use|install|add|run|invoke) any (?:tool|plugin|extension)s?\b/,
  /\b(?:full|unrestricted|all) tools?\b/,
  /\b(?:grant|allow|enable) tool (?:access|availability)\b/,
  /\bwithout using (?:the )?action gateway\b/,
];

const APPROVAL_PATTERNS = [
  /\b(?:skip|bypass|no|without|never seek|auto[- ]?approve|self[- ]?approve) (?:the )?approval\b/,
  /\b(?:approve|approval) (?:yourself|it yourself|without review)\b/,
  /\bapprove\b[^.!?\n]{0,40}\bwithout (?:review|human approval)\b/,
  /\bignore approvals?\b/,
];

const NETWORK_PATTERNS = [
  /\b(?:allow|enable|open|grant|turn ?on) network (?:access|requests?|traffic)?\b/,
  /\bfree network\b/,
  /\b(?:network|internet) access\b/,
];

const SANDBOX_PATTERNS = [
  /\b(?:disable|escape|bypass|no|without) (?:the )?sandbox\b/,
  /\b(?:host|system|root) access\b/,
  /\b(?:run|execute) (?:as|with) (?:root|admin)\b/,
  /\bourside (?:the )?sandbox\b/,
];

const VALIDATION_PATTERNS = [
  /\b(?:skip|bypass|no|without|avoid) (?:the )?(?:tests|validation|lint|typecheck|checks)\b/,
  /\bdon'?t (?:run|write) tests\b/,
  /\bnever validate\b/,
];

const ACTION_RISK_PATTERNS = [
  /\b(?:ignore|bypass|override) (?:the )?(?:risk|ceiling|budget)s?\b/,
  /\bunlimited (?:risk|budget|ceiling)\b/,
  /\blow[ -]?risk (?:anyway|regardless|without review)\b/,
];

const GLOBAL_PATTERNS = [
  /\b(?:ignore|override|bypass|disable) (?:the )?(?:policy|global (?:rules|safety)|guardrails?)\b/,
  /\bthese (?:rules|instructions) override\b/,
  /\bsystem (?:prompt|message)\b/,
];

const SCOPE_PATTERNS = [
  /\b(?:only|just|focus on|target|scope to?|touch)\b/,
  /\b(?:files?|directory|path|folder)s?\b/,
  /\b(?:do not touch|leave alone|same dir)\b/,
];

const STYLE_PATTERNS = [
  /\bstyle\b/,
  /\b(?:format|formatting|naming|convention|prefer|avoid|tabs|spaces|space|indent|indentation|quotes|semicolons|comments?)\b/,
];

function normalize(text: string): string {
  // Neutralize control characters (C016 §17 smuggling defense) without a
  // control-char regex literal (ESLint no-control-regex).
  const stripped = text.normalize('NFKC').toLowerCase();
  const cleaned = Array.from(stripped)
    .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
    .join('');
  return cleaned.slice(0, 8000);
}

function anyMatch(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

/** Deterministically classify a bounded instruction fragment. */
export function classifyDirective(text: string): DirectiveClassification {
  const input = normalize(text);

  if (anyMatch(input, SAFETY_PATTERNS))
    return { category: 'safety', grantsAuthority: false, overridesSafety: true };
  if (anyMatch(input, SECRET_PATTERNS.slice(1)) && !/\b(?:never|do not|don't)\s+(?:reveal|send|print|echo|share|upload|leak)\b/.test(input))
    return { category: 'secret', grantsAuthority: false, overridesSafety: true };
  if (anyMatch(input, TOOL_PATTERNS))
    return { category: 'tool', grantsAuthority: true, overridesSafety: false };
  if (anyMatch(input, AUTHORITY_GRANT_PATTERNS))
    return { category: 'authority_grant', grantsAuthority: true, overridesSafety: false };
  if (anyMatch(input, APPROVAL_PATTERNS))
    return { category: 'approval', grantsAuthority: true, overridesSafety: true };
  if (anyMatch(input, NETWORK_PATTERNS))
    return { category: 'network', grantsAuthority: true, overridesSafety: false };
  if (anyMatch(input, SANDBOX_PATTERNS))
    return { category: 'sandbox', grantsAuthority: true, overridesSafety: true };
  if (anyMatch(input, VALIDATION_PATTERNS))
    return { category: 'validation', grantsAuthority: false, overridesSafety: true };
  if (anyMatch(input, ACTION_RISK_PATTERNS))
    return { category: 'action_risk', grantsAuthority: false, overridesSafety: true };
  if (anyMatch(input, GLOBAL_PATTERNS))
    return { category: 'global', grantsAuthority: true, overridesSafety: true };
  if (anyMatch(input, SCOPE_PATTERNS))
    return { category: 'scope', grantsAuthority: false, overridesSafety: false };
  if (anyMatch(input, STYLE_PATTERNS))
    return { category: 'style', grantsAuthority: false, overridesSafety: false };
  return { category: 'unknown', grantsAuthority: false, overridesSafety: false };
}

/** Maps a classified directive to a rejection reason code (C016 §12). */
export function reasonCodeForCategory(
  category: DirectiveCategory,
): RejectionReasonCode | undefined {
  switch (category) {
    case 'authority_grant':
      return 'AUTHORITY_GRANT';
    case 'tool':
      return 'TOOL_AVAILABILITY';
    case 'approval':
      return 'APPROVAL_OVERRIDE';
    case 'secret':
      return 'SECRET_EXFILTRATION';
    case 'network':
      return 'NETWORK_ALLOW';
    case 'sandbox':
      return 'SANDBOX_OVERRIDE';
    case 'validation':
      return 'VALIDATION_BYPASS';
    case 'action_risk':
      return 'ACTION_RISK_OVERRIDE';
    case 'global':
      return 'GLOBAL_CONSTRAINT_OVERRIDE';
    case 'safety':
      return 'SAFETY_OVERRIDE';
    default:
      return undefined;
  }
}

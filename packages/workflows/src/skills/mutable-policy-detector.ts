/**
 * C045 §17/§23.4 — static mutable-policy and secret detector for skill assets.
 *
 * Skills are static build assets; they must NEVER carry mutable autonomy or
 * policy decisions (C045 §4.5/§17): no policy strings, no authorization
 * directives, no secrets/tokens, no repository/user content. This is a
 * conservative, line-based static scan — it is a gate, not a substitute for
 * the authoring review. Anything that looks like a directive or a secret
 * FAILS CLOSED at build time.
 */
import type { SkillContentShape } from '../schemas/skill-asset.js';

export type PolicyIssueKind =
  'mutable_policy_directive' | 'secret_shape' | 'prohibited_mutable_field';

export interface PolicyIssue {
  readonly kind: PolicyIssueKind;
  readonly line: number;
  readonly detail: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'generic-secret-hex', pattern: /\b[0-9a-f]{40,64}\b/gi },
]);

/**
 * Imperative policy/authorization directives. Conservative line scan: a
 * skill that lets the agent decide authority, skip approval, or mutate
 * policy state is rejected outright.
 */
const DIRECTIVE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: 'self-approval', pattern: /(?:approve|authorize|permit)\s+(?:your|its|own)\s+/gi },
  {
    name: 'autonomy-assignment',
    pattern:
      /\b(?:set|raise|override|grant|change)\b.{0,24}\b(?:autonomy|autonomyLevel|policy|authority|approval|approvalLevel)\b/gi,
  },
  {
    name: 'authorization-directive',
    pattern:
      /\b(?:you\s+(?:may|can|must|should|will)\s+)?(?:approve|merge|push|grant|deny|allow|bypass|skip)\s+[^\n.]*?(?:approval|review|policy|authorization|gate)\b/gi,
  },
  { name: 'policy-value', pattern: /\b(?:policy|approval|autonomy)\s*[:=]\s*["']?[A-Z_]+\b/gi },
  {
    name: 'skip-gate',
    pattern:
      /\b(?:bypass|skip|disable|ignore)\b.{0,32}\b(?:approval|authorization|policy|gate|validation)\b/gi,
  },
]);

function scanLine(content: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(content);
}

/**
 * Scan a skill source for mutable-policy directives, secret shapes and
 * references to fields the asset itself marks as prohibited.
 */
export function detectMutablePolicy(asset: SkillContentShape): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const lines = asset.content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    for (const { name, pattern } of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        issues.push({
          kind: 'secret_shape',
          line: lineNumber,
          detail: `line matches secret shape '${name}'`,
        });
        break;
      }
    }

    if (!issues.some((entry) => entry.line === lineNumber)) {
      for (const { name, pattern } of DIRECTIVE_PATTERNS) {
        if (scanLine(line, pattern)) {
          issues.push({
            kind: 'mutable_policy_directive',
            line: lineNumber,
            detail: `line matches mutable-policy directive '${name}'`,
          });
          break;
        }
      }
    }

    if (!issues.some((entry) => entry.line === lineNumber)) {
      for (const field of asset.prohibitedMutableFields) {
        if (new RegExp(`\\b${field}\\b`, 'g').test(line)) {
          issues.push({
            kind: 'prohibited_mutable_field',
            line: lineNumber,
            detail: `line references prohibited mutable field '${field}'`,
          });
          break;
        }
      }
    }
  }

  return Object.freeze(issues);
}

/** True when the asset is free of mutable-policy/secret issues. */
export function isSkillAssetSafe(asset: SkillContentShape): boolean {
  return detectMutablePolicy(asset).length === 0;
}

/** Throwing variant for the registry build path. */
export function assertSkillAssetSafe(asset: SkillContentShape): void {
  const issues = detectMutablePolicy(asset);
  if (issues.length === 0) return;
  const first = issues[0];
  if (first === undefined) return;
  throw new Error(
    `skill '${asset.id}@${asset.version.major}.${asset.version.minor}.${asset.version.patch}' rejected: ` +
      `${first.detail} at line ${first.line}`,
  );
}

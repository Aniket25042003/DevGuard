/**
 * C092 — Deterministic injection-signal scanner (defense-in-depth ONLY).
 *
 * Signals are EVIDENCE. They may raise risk, force exclusion/quarantine, or
 * trigger review; they can never authorize an action or downgrade a policy
 * decision (C092 §17). Absence of signals is never proof of safety.
 *
 * Rules are intentionally simple and auditable. A future advisory classifier
 * plugs in behind the same return shape without changing call sites.
 */
export interface InjectionSignal {
  readonly ruleId: string;
  /** Bounded redacted excerpt around the match — never the full payload. */
  readonly excerpt: string;
}

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { id: 'override_previous_instructions', pattern: /ignore\s+(all\s+)?(previous|prior|earlier)/i },
  { id: 'disregard_policy', pattern: /disregard\s+(all\s+)?(policy|policies|safety)/i },
  { id: 'role_hijack_you_are', pattern: /you\s+are\s+now\s+(a|an|the)\s+/i },
  { id: 'role_hijack_system_tag', pattern: /(^|\n)\s*system\s*:\s*/i },
  { id: 'chat_markup', pattern: /<\|(im_start|im_end|endoftext|system)\|>/i },
  { id: 'tool_call_markup', pattern: /<\|?tool_?call\|?>|"name"\s*:\s*"[a-z_]*tool/i },
  {
    id: 'approval_grant_claim',
    pattern: /\b(approve|accepted)\s+(this|the)\s+(action|operation|pull request|merge)\b/i,
  },
  { id: 'capability_grant_claim', pattern: /\bgrant(ed)?\s+(access|permission|capability)\b/i },
  {
    id: 'secret_exfil_attempt',
    pattern:
      /\b(reveal|print|show|output|dump)\s+(the\s+)?(api[_ ]?key|secret|password|token|credentials|environment)\b/i,
  },
  { id: 'policy_mutation_claim', pattern: /\bpolicy\s+version\s+(is\s+now|updated\s+to)\b/i },
  { id: 'developer_mode_claim', pattern: /developer\s+mode\s+(is\s+)?(on|enabled)/i },
  { id: 'hidden_instruction_marker', pattern: /\[\s*(INST|SYSTEM|\/SYSTEM)\s*\]/i },
];

const EXCERPT_WINDOW = 48;

function excerptAround(text: string, index: number): string {
  const start = Math.max(0, index - EXCERPT_WINDOW);
  const end = Math.min(text.length, index + EXCERPT_WINDOW);
  const raw = text.slice(start, end);
  // Redact anything secret-like before the excerpt leaves the scanner.
  return raw
    .replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scan text for injection signals. Pure, bounded, deterministic. */
export function detectInjectionSignals(text: string): InjectionSignal[] {
  if (text.length > 1_000_000) {
    // Bound work; oversized content is rejected at registration anyway.
    text = text.slice(0, 1_000_000);
  }
  const signals: InjectionSignal[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match !== null && match.index !== undefined) {
      signals.push({ ruleId: rule.id, excerpt: excerptAround(text, match.index) });
    }
  }
  return signals;
}

/**
 * CP019 — parse the first line of a GitHub issue/PR comment for `@devguard` verbs.
 * Bodies are untrusted: only the first line selects the verb; the remainder is notes.
 */
import { COMMAND_ALIASES_V1, type WorkflowIdV1 } from '@devguard/policy-engine';

export type GitHubCommentMetaVerb = 'help' | 'status';

export type ParsedGitHubComment =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'meta'; readonly verb: GitHubCommentMetaVerb }
  | {
      readonly kind: 'command';
      readonly verb: string;
      readonly commandId: WorkflowIdV1;
      readonly input: Record<string, unknown>;
      readonly notes: string;
    }
  | {
      readonly kind: 'denied';
      readonly code: 'COMMAND_UNKNOWN' | 'BOT_SELF';
      readonly detail: string;
    };

const META_VERBS = new Set<GitHubCommentMetaVerb>(['help', 'status']);

export interface ParseDevguardCommentOptions {
  readonly mentionLogin?: string | undefined;
  readonly authorLogin?: string | undefined;
}

/**
 * Parse a plaintext comment body (first line only for command selection).
 * Mention must be exact `@devguard` or `/devguard` alias on the first non-empty line.
 */
export function parseDevguardComment(
  body: string,
  options: ParseDevguardCommentOptions = {},
): ParsedGitHubComment {
  const mentionLogin = (options.mentionLogin ?? 'devguard').toLowerCase();
  const authorLogin = options.authorLogin?.toLowerCase();
  if (authorLogin !== undefined && authorLogin === mentionLogin) {
    return { kind: 'denied', code: 'BOT_SELF', detail: 'ignore comments from the app login' };
  }

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const firstLine = lines.find((line) => line.trim().length > 0);
  if (firstLine === undefined) return { kind: 'ignored' };

  const trimmed = firstLine.trim();
  const mentionPattern = new RegExp(`^[@/]${escapeRegExp(mentionLogin)}\\b`, 'i');
  if (!mentionPattern.test(trimmed)) return { kind: 'ignored' };

  const afterMention = trimmed.replace(mentionPattern, '').trim();
  if (afterMention.length === 0) {
    return { kind: 'meta', verb: 'help' };
  }

  const tokens = tokenize(afterMention);
  if (tokens.length === 0) return { kind: 'meta', verb: 'help' };

  const verb = tokens[0]!.toLowerCase();
  if (META_VERBS.has(verb as GitHubCommentMetaVerb)) {
    return { kind: 'meta', verb: verb as GitHubCommentMetaVerb };
  }

  const alias = COMMAND_ALIASES_V1[verb];
  if (alias === undefined) {
    return { kind: 'denied', code: 'COMMAND_UNKNOWN', detail: `Unknown verb '${verb}'.` };
  }

  const tail = tokens.slice(1);
  const parsedTail = parseTail(alias, verb, tail);
  if (!parsedTail.ok) {
    return { kind: 'denied', code: 'COMMAND_UNKNOWN', detail: parsedTail.detail };
  }

  const notes = lines
    .slice(lines.indexOf(firstLine) + 1)
    .join('\n')
    .trim();
  return {
    kind: 'command',
    verb,
    commandId: alias,
    input: parsedTail.input,
    notes,
  };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /(\S+=\S+|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1]!);
  }
  return out;
}

function parseTail(
  commandId: WorkflowIdV1,
  verb: string,
  tail: readonly string[],
):
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string } {
  const kv = readKeyValues(tail);
  const positional = tail.filter((token) => !token.includes('='));

  if (commandId === 'review_remediation') {
    if (positional.length === 0) {
      return { ok: true, input: buildReviewInput(kv) };
    }
    if (positional.length === 1 && isNestedReview(positional[0]!)) {
      return { ok: true, input: buildReviewInput(kv) };
    }
    return { ok: false, detail: 'Unexpected tokens after review.' };
  }

  if (commandId === 'diagnose_failure') {
    const issue = readIssueShorthand(verb, positional, kv);
    if (issue !== undefined) {
      return {
        ok: true,
        input: {
          pullRequestNumber: issue,
          ...(typeof kv['check'] === 'string' ? { checkRunId: kv['check'] } : {}),
        },
      };
    }
    if (positional.length > 0) {
      return { ok: false, detail: 'Unexpected tokens after fix.' };
    }
    return {
      ok: true,
      input: {
        ...(typeof kv['pr'] === 'string' && /^\d+$/.test(kv['pr']) && Number(kv['pr']) > 0
          ? { pullRequestNumber: Number(kv['pr']) }
          : {}),
        ...(typeof kv['check'] === 'string' ? { checkRunId: kv['check'] } : {}),
      },
    };
  }

  if (commandId === 'implement_issue') {
    const issue = readIssueShorthand(verb, positional, kv);
    if (issue !== undefined) return { ok: true, input: { issueNumber: issue } };
    if (positional.length > 0) {
      return { ok: false, detail: 'Unexpected tokens after implement.' };
    }
    if (typeof kv['issue'] === 'string') {
      if (!/^\d+$/.test(kv['issue']) || Number(kv['issue']) <= 0) {
        return { ok: false, detail: 'Invalid issue number.' };
      }
      return { ok: true, input: { issueNumber: Number(kv['issue']) } };
    }
    return { ok: true, input: {} };
  }

  if (commandId === 'security_patch') {
    const finding = kv['finding'] ?? kv['findings'];
    if (positional.length > 0) {
      return { ok: false, detail: 'Unexpected tokens after patch.' };
    }
    return {
      ok: true,
      input: {
        ...(finding !== undefined
          ? {
              findingIds: finding
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            }
          : {}),
      },
    };
  }

  if (commandId === 'security_audit') {
    if (positional.length > 0) {
      return { ok: false, detail: 'Unexpected tokens after audit.' };
    }
    return {
      ok: true,
      input: typeof kv['ref'] === 'string' ? { ref: kv['ref'] } : {},
    };
  }

  if (positional.length > 0) {
    return { ok: false, detail: `Unexpected tokens after ${verb}.` };
  }
  return { ok: true, input: {} };
}

function readKeyValues(tokens: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);
    if (value.length > 0) out[key] = value;
  }
  return out;
}

function isNestedReview(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === 'remediation' || lower === 'remediations';
}

function readIssueShorthand(
  verb: string,
  positional: readonly string[],
  kv: Record<string, string>,
): number | undefined {
  if (typeof kv['issue'] === 'string' && /^\d+$/.test(kv['issue'])) {
    return Number(kv['issue']);
  }
  if (
    positional.length === 2 &&
    positional[0]!.toLowerCase() === 'issue' &&
    /^\d+$/.test(positional[1]!)
  ) {
    return Number(positional[1]);
  }
  if (verb === 'implement' && positional.length === 1 && /^\d+$/.test(positional[0]!)) {
    return Number(positional[0]);
  }
  return undefined;
}

function buildReviewInput(kv: Record<string, string>): Record<string, unknown> {
  if (typeof kv['pr'] === 'string' && /^\d+$/.test(kv['pr'])) {
    return { pullRequestNumber: Number(kv['pr']) };
  }
  return {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CP019 idempotency key: one run per comment + canonical verb. */
export function githubCommentIdempotencyKey(commentId: string | number, commandId: string): string {
  return `github_comment:${String(commentId)}:${commandId}`;
}

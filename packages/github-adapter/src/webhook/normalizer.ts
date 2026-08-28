/**
 * C022 §10/§12/§18 — webhook payload normalizer.
 *
 * Parses only bounded, schema-valid JSON AFTER signature verification. Explicit
 * event/action shapes normalize into `NormalizedWebhookEvent`; unknown actions
 * and unsupported events are an auditable `ignored`, never an error.
 */
import { bytesToString } from './delivery-ledger.js';
import {
  normalizedWebhookEventSchema,
  type NormalizedWebhookEvent,
  type WebhookEventName,
} from './contracts.js';

export type NormalizationResult =
  | { readonly ok: true; readonly event: NormalizedWebhookEvent }
  | { readonly ok: false; readonly reason: 'UNSUPPORTED' | 'MALFORMED' | 'UNKNOWN_ACTION' };

const MAX_JSON_DEPTH = 64;

function parseBounded(raw: string): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length && depth <= MAX_JSON_DEPTH; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }
  if (depth > MAX_JSON_DEPTH) throw new Error('payload too deep');
  return JSON.parse(raw);
}

export class WebhookNormalizer {
  normalize(rawBody: Uint8Array, eventHeader: WebhookEventName): NormalizationResult {
    let parsed: unknown;
    try {
      parsed = parseBounded(bytesToString(rawBody));
    } catch {
      return { ok: false, reason: 'MALFORMED' };
    }
    const payload =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (payload === null) return { ok: false, reason: 'MALFORMED' };

    const action = typeof payload.action === 'string' ? payload.action : undefined;
    const repo = safeRepo(payload.repository);
    const after = typeof payload.after === 'string' ? payload.after : undefined;
    const headCommitId =
      payload.head_commit !== null && typeof payload.head_commit === 'object'
        ? (payload.head_commit as Record<string, unknown>).id
        : undefined;
    const headSha =
      after !== undefined && /^[0-9a-f]{40}$/.test(after)
        ? after
        : typeof headCommitId === 'string'
          ? (headCommitId as string)
          : undefined;
    const prNumber =
      payload.pull_request &&
      typeof (payload.pull_request as Record<string, unknown>).number === 'number'
        ? ((payload.pull_request as Record<string, unknown>).number as number)
        : payload.number && typeof payload.number === 'number'
          ? (payload.number as number)
          : undefined;
    const issueNumber =
      payload.issue && typeof (payload.issue as Record<string, unknown>).number === 'number'
        ? ((payload.issue as Record<string, unknown>).number as number)
        : undefined;

    const candidate = {
      event: eventHeader,
      ...(action !== undefined ? { action } : {}),
      ...(repo !== undefined ? { repository: repo } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
    };
    const parsedEvent = normalizedWebhookEventSchema.safeParse(candidate);
    if (!parsedEvent.success) return { ok: false, reason: 'UNKNOWN_ACTION' };
    return { ok: true, event: parsedEvent.data };
  }
}

function safeRepo(unknown: unknown):
  | {
      owner: string;
      repo: string;
      providerRepositoryId: string;
      defaultBranch?: string | undefined;
    }
  | undefined {
  if (unknown === null || typeof unknown !== 'object' || Array.isArray(unknown)) return undefined;
  const record = unknown as Record<string, unknown>;
  const ownerObj =
    typeof record.owner === 'object' && record.owner !== null
      ? (record.owner as Record<string, unknown>)
      : null;
  const owner =
    typeof ownerObj?.login === 'string'
      ? (ownerObj.login as string)
      : typeof record.owner === 'string'
        ? (record.owner as string)
        : undefined;
  const repo = typeof record.name === 'string' ? (record.name as string) : undefined;
  const id =
    typeof record.id === 'string'
      ? (record.id as string)
      : record.id !== null && typeof record.id === 'number'
        ? String(record.id)
        : undefined;
  const defaultBranch =
    typeof record.default_branch === 'string' ? (record.default_branch as string) : undefined;
  if (owner === undefined || repo === undefined || id === undefined) return undefined;
  return {
    owner,
    repo,
    providerRepositoryId: id,
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
  };
}

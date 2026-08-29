/**
 * CP019 — extract bounded fields from a GitHub `issue_comment` webhook payload.
 * Never trust HTML; callers should pass the JSON body from the verified webhook.
 */
export interface IssueCommentWebhookEvent {
  readonly action: string;
  readonly comment: {
    readonly id: number;
    readonly body: string;
    readonly user: { readonly id: number; readonly login: string };
  };
  readonly issue: {
    readonly number: number;
    readonly pull_request?: { readonly url?: string | undefined } | undefined;
  };
  readonly repository: {
    readonly id: number;
    readonly owner: { readonly login: string };
    readonly name: string;
    readonly full_name?: string | undefined;
  };
  readonly installation?: { readonly id: number } | undefined;
}

export function parseIssueCommentWebhook(payload: unknown): IssueCommentWebhookEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (record['action'] !== 'created') return undefined;
  const comment = record['comment'];
  const issue = record['issue'];
  const repository = record['repository'];
  if (typeof comment !== 'object' || comment === null) return undefined;
  if (typeof issue !== 'object' || issue === null) return undefined;
  if (typeof repository !== 'object' || repository === null) return undefined;
  const c = comment as Record<string, unknown>;
  const user = c['user'];
  if (typeof user !== 'object' || user === null) return undefined;
  const u = user as Record<string, unknown>;
  if (typeof c['id'] !== 'number' || typeof c['body'] !== 'string') return undefined;
  if (typeof u['id'] !== 'number' || typeof u['login'] !== 'string') return undefined;
  const i = issue as Record<string, unknown>;
  if (typeof i['number'] !== 'number') return undefined;
  const r = repository as Record<string, unknown>;
  const owner = r['owner'];
  if (typeof owner !== 'object' || owner === null) return undefined;
  const o = owner as Record<string, unknown>;
  if (typeof r['id'] !== 'number' || typeof r['name'] !== 'string') return undefined;
  if (typeof o['login'] !== 'string') return undefined;
  const installation = record['installation'];
  return {
    action: 'created',
    comment: {
      id: c['id'],
      body: c['body'],
      user: { id: u['id'], login: u['login'] },
    },
    issue: {
      number: i['number'],
      ...(typeof i['pull_request'] === 'object' && i['pull_request'] !== null
        ? { pull_request: i['pull_request'] as { url?: string } }
        : {}),
    },
    repository: {
      id: r['id'],
      owner: { login: o['login'] },
      name: r['name'],
      ...(typeof r['full_name'] === 'string' ? { full_name: r['full_name'] } : {}),
    },
    ...(typeof installation === 'object' &&
    installation !== null &&
    typeof (installation as Record<string, unknown>)['id'] === 'number'
      ? { installation: { id: (installation as { id: number }).id } }
      : {}),
  };
}

export function issueCommentIsOnPullRequest(event: IssueCommentWebhookEvent): boolean {
  return event.issue.pull_request !== undefined;
}

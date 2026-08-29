import { parseIssueCommentWebhook, type IssueCommentWebhookEvent } from '@devguard/workflows';

export function parseWorkerIssueCommentPayload(
  issueCommentPayload: string | undefined,
): IssueCommentWebhookEvent | undefined {
  if (issueCommentPayload === undefined || issueCommentPayload === '') return undefined;
  try {
    return parseIssueCommentWebhook(JSON.parse(issueCommentPayload) as unknown);
  } catch {
    return undefined;
  }
}

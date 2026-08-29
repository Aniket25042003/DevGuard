import type { ReactNode } from 'react';
import { WorkflowRunDetailPage } from '@/features/session-timeline/components/run-detail-page';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ repositoryId: string; runId: string }>;
}): Promise<ReactNode> {
  const { repositoryId, runId } = await params;
  return <WorkflowRunDetailPage repositoryId={repositoryId} runId={runId} />;
}

import type { ReactNode } from 'react';
import { WorkflowLauncherPage } from '@/features/workflow-launcher/components/launcher-page';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}): Promise<ReactNode> {
  const { repositoryId } = await params;
  return <WorkflowLauncherPage repositoryId={repositoryId} />;
}

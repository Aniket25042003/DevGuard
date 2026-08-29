import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { RepositoryDashboardPage } from '@/features/dashboard/components/dashboard-page';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}): Promise<ReactNode> {
  const { repositoryId } = await params;
  return (
    <Suspense fallback={<p role="status">Loading repository…</p>}>
      <RepositoryDashboardPage repositoryId={repositoryId} />
    </Suspense>
  );
}

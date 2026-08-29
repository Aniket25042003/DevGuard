import type { ReactNode } from 'react';
import { PolicyEditorPage } from '@/features/policies/components/policy-editor';

export default async function Page({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}): Promise<ReactNode> {
  const { repositoryId } = await params;
  return <PolicyEditorPage repositoryId={repositoryId} />;
}

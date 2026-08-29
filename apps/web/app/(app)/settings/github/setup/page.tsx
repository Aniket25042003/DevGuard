import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { GitHubSetupPage } from '@/features/github/components/github-setup-page';

export default function Page(): ReactNode {
  return (
    <Suspense fallback={<p role="status">Loading setup…</p>}>
      <GitHubSetupPage />
    </Suspense>
  );
}

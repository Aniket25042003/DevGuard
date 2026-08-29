import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { AuthCallbackPage } from '@/features/auth/components/auth-pages';

export default function Page(): ReactNode {
  return (
    <Suspense fallback={<p role="status">Loading callback…</p>}>
      <AuthCallbackPage />
    </Suspense>
  );
}

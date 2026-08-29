import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { SignInPage } from '@/features/auth/components/auth-pages';

export default function Page(): ReactNode {
  return (
    <Suspense fallback={<p role="status">Loading sign-in…</p>}>
      <SignInPage />
    </Suspense>
  );
}

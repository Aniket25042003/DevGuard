import type { ReactNode } from 'react';
import { SkipLink } from '@/components/ui/primitives';

export default function PublicLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <>
      <SkipLink />
      <main id="main">{children}</main>
    </>
  );
}

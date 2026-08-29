'use client';

import type { ReactNode } from 'react';
import { AppShell, AuthGate } from '@/components/shell/app-shell';

export default function AppLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}

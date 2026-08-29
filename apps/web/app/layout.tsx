import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/lib/server-state/query-client';
import { PRODUCT_NAME } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: 'DevGuard control plane — one /api/v1 backend for web, CLI, and GitHub.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}

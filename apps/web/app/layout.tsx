import type { Metadata } from 'next';
import { Bricolage_Grotesque, Figtree, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/lib/server-state/query-client';
import { PRODUCT_NAME } from '@/lib/brand';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
});

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — Governed AI engineering for GitHub`,
  description:
    'DevGuard is the control plane for autonomous software engineering — policy, approvals, sandboxed execution, and GitHub-native workflows.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${figtree.variable} ${bricolage.variable} ${jetbrains.variable}`}>
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}

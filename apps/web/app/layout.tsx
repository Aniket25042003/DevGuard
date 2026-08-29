import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/lib/server-state/query-client';
import { PRODUCT_NAME } from '@/lib/brand';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space',
  display: 'swap',
});

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — Governed AI engineering for GitHub`,
  description:
    'DevGuard is the control plane for autonomous software engineering — policy, approvals, sandboxed execution, and GitHub-native workflows.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}

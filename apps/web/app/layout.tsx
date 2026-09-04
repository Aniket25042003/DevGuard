import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '@/lib/server-state/query-client';
import { PRODUCT_NAME } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — Governed AI engineering for GitHub`,
  description:
    'DevGuard is the control plane for autonomous software engineering — policy, approvals, sandboxed execution, and GitHub-native workflows.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        {/*
          THESIS: DevGuard is a calm, evidence-driven command center for governed agent work.
          OWN-WORLD: graphite surfaces, precise dividers, teal verified state, amber human gates.
          STORY: understand what is happening, why it is safe, and what needs a decision.
          FIRST VIEWPORT: repository context and the next operator action lead every page.
          FORM: an operational console; cards are reserved for evidence and decisions.
          FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
        */}
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}

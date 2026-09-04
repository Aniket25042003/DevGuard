import Link from 'next/link';
import type { ReactNode } from 'react';
import { PRODUCT_NAME } from '@/lib/brand';
import { buildAppHref } from '@/features/navigation/routes';
import { LandingAuthRedirect } from '@/features/marketing/components/landing-auth-redirect';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';

const SIGN_IN = buildAppHref({ name: 'signIn', returnTo: '/repositories' });

const FEATURES = [
  [
    'Policy before execution',
    'A repository policy snapshot travels with every run. Unknown or ambiguous actions fail closed.',
  ],
  [
    'Sandbox as a boundary',
    'Agent code runs in isolated TrueForge workspaces, never on the DevGuard host.',
  ],
  [
    'Evidence as the output',
    'Events, artifacts, findings, and validation make every result inspectable after the work is done.',
  ],
  [
    'Humans authorize effects',
    'Sensitive writes pause on an exact fingerprint until the right maintainer approves.',
  ],
] as const;

export function LandingPage(): ReactNode {
  return (
    <div className="marketing-canvas min-h-screen">
      <LandingAuthRedirect />
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-6 sm:px-10">
        <Link href="/" className="flex items-center gap-3" aria-label={PRODUCT_NAME}>
          <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <Icon name="shield" size={17} />
          </span>
          <span className="text-sm font-bold tracking-tight">{PRODUCT_NAME}</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link
            href={SIGN_IN}
            className="hidden min-h-11 items-center px-4 text-sm font-semibold text-[var(--muted)] transition hover:text-[var(--ink)] sm:inline-flex"
          >
            Sign in
          </Link>
          <Button href={SIGN_IN} icon="arrow-up-right">
            Open control plane
          </Button>
        </nav>
      </header>
      <main>
        <section className="mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-14 sm:px-10 sm:pb-28 sm:pt-20 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
          <div className="max-w-2xl">
            <h1 className="font-[family-name:var(--font-display)] text-[clamp(2.8rem,7vw,5.75rem)] font-semibold leading-[0.96] tracking-[-0.055em]">
              Agent speed.
              <br />
              <span className="text-[var(--accent)]">Team control.</span>
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-[var(--muted)]">
              {PRODUCT_NAME} is the operating layer for autonomous engineering on GitHub. Define how
              agents work, isolate execution, and keep a durable record of every decision.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button href={SIGN_IN} size="lg" icon="github">
                Sign in with GitHub
              </Button>
              <Button href="#features" tone="ghost" size="lg" icon="chevron-right">
                See the control model
              </Button>
            </div>
            <p className="mt-5 text-xs text-[var(--subtle)]">
              Policy · sandbox · approval · evidence
            </p>
          </div>
          <GovernedRunDiagram />
        </section>
        <section
          id="features"
          className="section-rule mx-auto max-w-7xl px-5 py-20 sm:px-10 sm:py-28"
        >
          <div className="max-w-2xl">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              The control plane for work that can change code.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-[var(--muted)]">
              One governed path from intent to verified outcome, regardless of whether work starts
              in the web app, CLI, or GitHub.
            </p>
          </div>
          <div className="mt-14 divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {FEATURES.map(([title, body]) => (
              <article
                key={title}
                className="grid gap-4 py-7 sm:grid-cols-[0.8fr_1.2fr] sm:items-start"
              >
                <h3 className="text-lg font-bold tracking-tight">{title}</h3>
                <p className="max-w-xl text-sm leading-relaxed text-[var(--muted)]">{body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="mx-auto max-w-7xl px-5 py-20 sm:px-10 sm:py-28">
          <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:items-end">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              Make the rules once.
              <br />
              See them in every run.
            </h2>
            <ol className="grid gap-7 sm:grid-cols-3">
              {[
                ['Connect', 'Link GitHub and choose the repositories your team governs.'],
                [
                  'Set the work style',
                  'Choose autonomy, actions, approval gates, and required validation.',
                ],
                [
                  'Review the proof',
                  'Follow agent events, sandbox evidence, and the exact outcome.',
                ],
              ].map(([title, body]) => (
                <li key={title} className="border-t border-[var(--line)] pt-4">
                  <h3 className="font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section className="mx-auto max-w-7xl px-5 pb-24 sm:px-10 sm:pb-32">
          <div className="surface-soft flex flex-col gap-7 rounded-[var(--radius-lg)] p-7 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-[-0.03em]">
                Ready to govern your first repository?
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">
                Connect GitHub, set a policy, and inspect the first run from one calm workspace.
              </p>
            </div>
            <Button href={SIGN_IN} size="lg" icon="arrow-up-right">
              Get started
            </Button>
          </div>
        </section>
      </main>
      <footer className="section-rule py-7">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 text-xs text-[var(--subtle)] sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <p>
            © {new Date().getFullYear()} {PRODUCT_NAME}
          </p>
          <p>Governed AI engineering for GitHub</p>
        </div>
      </footer>
    </div>
  );
}

function GovernedRunDiagram(): ReactNode {
  const steps = [
    ['Intent', 'PR #142 · review remediation', 'code'],
    ['Policy gate', 'supervised · write risk', 'sliders'],
    ['TrueForge sandbox', 'isolated workspace · running', 'terminal'],
    ['Human approval', 'exact fingerprint · required', 'shield'],
    ['Verified outcome', 'evidence attached · recorded', 'check'],
  ] as const;
  return (
    <div
      className="run-diagram"
      aria-label="Example governed workflow from intent to verified outcome"
    >
      <div className="mb-5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
          Live run model
        </span>
        <span className="flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
          <span className="size-2 animate-pulse rounded-full bg-[var(--accent)]" /> Event stream
        </span>
      </div>
      <ol className="space-y-0">
        {steps.map(([title, detail, icon], index) => (
          <li key={title} className="run-step">
            <span className="run-step-marker">
              <Icon name={icon} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="text-sm font-bold">{title}</p>
                <span className="font-mono text-[0.65rem] text-[var(--subtle)]">0{index + 1}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">{detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 border-t border-[var(--line)] pt-4 font-mono text-[0.65rem] text-[var(--subtle)]">
        Every transition is server-confirmed and replayable.
      </div>
    </div>
  );
}

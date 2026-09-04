import Link from 'next/link';
import type { ReactNode } from 'react';
import { PRODUCT_NAME } from '@/lib/brand';
import { buildAppHref } from '@/features/navigation/routes';
import { LandingAuthRedirect } from '@/features/marketing/components/landing-auth-redirect';
import { Badge, Button } from '@/components/ui/primitives';

const SIGN_IN = buildAppHref({ name: 'signIn', returnTo: '/repositories' });

const FEATURES = [
  {
    title: 'Policy-first autonomy',
    description:
      'Set what agents can do before they run. Risk tiers and approval gates travel with every workflow.',
  },
  {
    title: 'Sandboxed execution',
    description:
      'Generated code runs in isolated workspaces via TrueForge — never on the DevGuard host.',
  },
  {
    title: 'GitHub-native',
    description:
      'OAuth for identity, GitHub App for repos, webhooks for events, and PR-aware history.',
  },
  {
    title: 'Human-in-the-loop',
    description:
      'Sensitive writes pause for approval. One queue for pending actions across repositories.',
  },
] as const;

const STEPS = [
  { title: 'Connect', body: 'Sign in with GitHub and install the DevGuard App on your repos.' },
  { title: 'Configure', body: 'Set autonomy levels, connect TrueForge, and tune policy per repo.' },
  { title: 'Launch', body: 'Start workflows from web, CLI, or GitHub — every run is audited.' },
] as const;

export function LandingPage(): ReactNode {
  return (
    <div className="marketing-canvas min-h-screen">
      <LandingAuthRedirect />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 font-[family-name:var(--font-display)] text-lg font-semibold tracking-[-0.02em]"
        >
          <span className="size-2.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />
          {PRODUCT_NAME}
        </Link>
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            href={SIGN_IN}
            className="hidden min-h-10 items-center rounded-[var(--radius-pill)] px-4 text-sm font-medium text-[var(--muted)] transition hover:bg-[var(--bg-elevated)] hover:text-[var(--ink)] sm:inline-flex"
          >
            Sign in
          </Link>
          <Button href={SIGN_IN}>Get started</Button>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-20 pt-10 sm:px-8 sm:pb-28 sm:pt-16">
          <div className="mx-auto max-w-3xl text-center">
            <Badge tone="accent">Governed AI engineering</Badge>
            <h1 className="mt-5 font-[family-name:var(--font-display)] text-[2.75rem] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl lg:text-[3.5rem]">
              Ship faster with agents.
              <span className="block text-[var(--accent)]">Stay in control.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--muted)] leading-relaxed">
              {PRODUCT_NAME} is the friendly control plane for autonomous software engineering on
              GitHub — policy, approvals, and sandboxed execution in one place.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Button href={SIGN_IN} size="lg">
                Sign in with GitHub
              </Button>
              <Button href="#features" tone="neutral" size="lg">
                See how it works
              </Button>
            </div>
          </div>

          <div className="mx-auto mt-16 max-w-3xl">
            <aside
              className="terminal-preview rounded-[var(--radius-lg)] p-6 sm:p-7"
              aria-label="Example workflow run"
            >
              <p className="text-[var(--muted)]">
                <span className="text-[var(--accent)]">$</span> devguard run review_remediation --pr
                142
              </p>
              <p className="mt-3 text-[var(--muted)]">policy: autonomy=supervised · risk=write</p>
              <p className="mt-1">queued → running → waiting_for_approval</p>
              <p className="mt-3 text-[var(--warn)]">
                approval required: push to feature/auth-refactor
              </p>
              <p className="mt-3 text-[var(--ok)]">approved · run completed in 4m 12s</p>
            </aside>
          </div>

          <dl className="mx-auto mt-14 grid max-w-4xl gap-4 sm:grid-cols-3">
            {[
              { term: 'Execution', detail: 'Sandboxed' },
              { term: 'Identity', detail: 'GitHub OAuth' },
              { term: 'Governance', detail: 'Policy + approvals' },
            ].map((item) => (
              <div
                key={item.term}
                className="surface-soft rounded-[var(--radius-lg)] px-5 py-4 text-center"
              >
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
                  {item.term}
                </dt>
                <dd className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="features" className="py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                Everything you need to run agents safely
              </h2>
              <p className="mt-3 text-[var(--muted)]">
                Built for teams who want speed without giving up oversight.
              </p>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2">
              {FEATURES.map((feature) => (
                <article
                  key={feature.title}
                  className="surface-soft rounded-[var(--radius-lg)] p-7 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
                >
                  <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-[var(--muted)] leading-relaxed">{feature.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-8">
            <h2 className="text-center font-[family-name:var(--font-display)] text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
              Up and running in minutes
            </h2>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((item, index) => (
                <li key={item.title} className="surface-soft rounded-[var(--radius-lg)] p-6">
                  <span className="inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-[family-name:var(--font-display)] text-xl font-semibold">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[var(--muted)] leading-relaxed">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="pb-20 sm:pb-28">
          <div className="mx-auto max-w-6xl px-4 sm:px-8">
            <div className="surface-soft flex flex-col items-center gap-6 rounded-[var(--radius-lg)] bg-[var(--accent-soft)] p-10 text-center sm:flex-row sm:justify-between sm:text-left">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-[-0.02em]">
                  Ready to try DevGuard?
                </h2>
                <p className="mt-2 max-w-xl text-[var(--muted)]">
                  Connect GitHub, onboard a repository, and launch your first governed workflow
                  today.
                </p>
              </div>
              <Button href={SIGN_IN} size="lg">
                Get started free
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--line)] py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-[var(--muted)] sm:flex-row sm:px-8">
          <p>
            © {new Date().getFullYear()} {PRODUCT_NAME}
          </p>
          <p>Governed AI engineering for GitHub</p>
        </div>
      </footer>
    </div>
  );
}

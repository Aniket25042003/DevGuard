import Link from 'next/link';
import type { ReactNode } from 'react';
import { PRODUCT_NAME } from '@/lib/brand';
import { buildAppHref } from '@/features/navigation/routes';

const FEATURES = [
  {
    title: 'Policy-first autonomy',
    description:
      'Define what agents may do before they run. Risk tiers, approval gates, and repository-scoped policy travel with every workflow.',
  },
  {
    title: 'Sandboxed execution',
    description:
      'Generated code runs in isolated workspaces via TrueForge — never on the DevGuard control plane host.',
  },
  {
    title: 'GitHub-native',
    description:
      'OAuth for identity, GitHub App for repository access, webhooks for events, and PR-aware workflow history.',
  },
  {
    title: 'Human-in-the-loop',
    description:
      'Sensitive writes pause for explicit approval. Operators see pending actions in one queue across repositories.',
  },
] as const;

const STEPS = [
  { step: '01', title: 'Connect', body: 'Sign in with GitHub and install the DevGuard App on your repositories.' },
  { step: '02', title: 'Configure', body: 'Set autonomy levels, connect TrueForge, and tune policy per repository.' },
  { step: '03', title: 'Launch', body: 'Start workflows from the web, CLI, or GitHub — every run is audited and governed.' },
] as const;

export function LandingPage(): ReactNode {
  return (
    <div className="hero-glow min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-6 sm:px-8">
        <Link href="/" className="font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight">
          {PRODUCT_NAME}
        </Link>
        <nav className="flex items-center gap-3">
          <Link
            href={buildAppHref({ name: 'signIn' })}
            className="hidden min-h-11 items-center rounded-lg px-4 text-sm font-medium text-[var(--muted)] transition hover:text-[var(--ink)] sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href={buildAppHref({ name: 'signIn' })}
            className="inline-flex min-h-11 items-center rounded-lg bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-ink)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--accent-hover)]"
          >
            Get started
          </Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-20 pt-12 sm:px-8 sm:pt-20">
          <div className="max-w-3xl">
            <p className="mb-4 inline-flex rounded-full border border-[var(--line)] bg-[var(--bg-elevated)] px-3 py-1 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
              Governed AI engineering
            </p>
            <h1 className="font-[family-name:var(--font-display)] text-4xl font-semibold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Ship with agents.
              <span className="block text-[var(--accent)]">Stay in control.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-[var(--muted)]">
              {PRODUCT_NAME} is the control plane for autonomous software engineering — policy, approvals,
              sandboxed execution, and GitHub-native workflows in one professional workspace.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                href={buildAppHref({ name: 'signIn' })}
                className="inline-flex min-h-12 items-center rounded-xl bg-[var(--accent)] px-6 text-base font-medium text-[var(--accent-ink)] shadow-[var(--shadow-md)] transition hover:bg-[var(--accent-hover)]"
              >
                Sign in with GitHub
              </Link>
              <a
                href="#features"
                className="inline-flex min-h-12 items-center rounded-xl border border-[var(--line)] bg-[var(--bg-elevated)] px-6 text-base font-medium transition hover:border-[var(--accent)]"
              >
                Explore features
              </a>
            </div>
          </div>

          <div className="mt-16 grid gap-4 sm:grid-cols-3">
            {[
              { label: 'Execution', value: 'Sandboxed' },
              { label: 'Identity', value: 'GitHub OAuth' },
              { label: 'Governance', value: 'Policy + approvals' },
            ].map((item) => (
              <div key={item.label} className="glass-panel rounded-2xl p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">{item.label}</p>
                <p className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold">{item.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="border-t border-[var(--line)] bg-[var(--bg-muted)] py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-8">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
              Built for production engineering teams
            </h2>
            <p className="mt-3 max-w-2xl text-[var(--muted)]">
              Every surface is server-confirmed. The UI reflects API truth — empty states, degraded health, and
              pending approvals are never hidden.
            </p>
            <div className="mt-12 grid gap-6 sm:grid-cols-2">
              {FEATURES.map((feature) => (
                <article
                  key={feature.title}
                  className="rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-6 shadow-[var(--shadow-sm)] transition hover:shadow-[var(--shadow-md)]"
                >
                  <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-[var(--muted)]">{feature.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-8">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
              How it works
            </h2>
            <ol className="mt-12 grid gap-8 md:grid-cols-3">
              {STEPS.map((item) => (
                <li key={item.step} className="relative">
                  <span className="font-[family-name:var(--font-display)] text-4xl font-bold text-[var(--accent-soft)]">
                    {item.step}
                  </span>
                  <h3 className="mt-2 font-[family-name:var(--font-display)] text-xl font-semibold">{item.title}</h3>
                  <p className="mt-2 text-[var(--muted)]">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-[var(--line)] bg-[var(--bg-elevated)] py-20">
          <div className="mx-auto max-w-6xl px-4 text-center sm:px-8">
            <h2 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
              Ready to govern your agent workflows?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[var(--muted)]">
              Connect your GitHub account, onboard repositories, and launch your first governed workflow in minutes.
            </p>
            <Link
              href={buildAppHref({ name: 'signIn' })}
              className="mt-8 inline-flex min-h-12 items-center rounded-xl bg-[var(--accent)] px-8 text-base font-medium text-[var(--accent-ink)] shadow-[var(--shadow-md)] transition hover:bg-[var(--accent-hover)]"
            >
              Go to sign in
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--line)] py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-[var(--muted)] sm:flex-row sm:px-8">
          <p>© {new Date().getFullYear()} {PRODUCT_NAME}</p>
          <p>Governed AI engineering for GitHub</p>
        </div>
      </footer>
    </div>
  );
}

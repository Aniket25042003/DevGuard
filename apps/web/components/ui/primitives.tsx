import type { ReactNode } from 'react';

const STATUS_COPY: Record<string, { label: string; icon: string }> = {
  queued: { label: 'Queued', icon: '○' },
  running: { label: 'Running', icon: '▸' },
  waiting_for_approval: { label: 'Waiting for approval', icon: '!' },
  resuming: { label: 'Resuming', icon: '▸' },
  verifying: { label: 'Verifying', icon: '▸' },
  completed: { label: 'Completed', icon: '✓' },
  failed: { label: 'Failed', icon: '×' },
  cancelled: { label: 'Cancelled', icon: '–' },
  rejected: { label: 'Rejected', icon: '×' },
  timed_out: { label: 'Timed out', icon: '×' },
  pending: { label: 'Pending', icon: '!' },
  approved: { label: 'Approved', icon: '✓' },
  stale: { label: 'Stale', icon: '!' },
  expired: { label: 'Expired', icon: '–' },
  ready: { label: 'Ready', icon: '✓' },
  degraded: { label: 'Degraded', icon: '!' },
  unknown: { label: 'Unknown', icon: '?' },
};

export function StatusBadge({
  status,
  label,
}: {
  readonly status: string;
  readonly label?: string;
}): ReactNode {
  const meta = STATUS_COPY[status] ?? { label: label ?? status, icon: '•' };
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span aria-hidden="true">{meta.icon}</span>
      <span>{label ?? meta.label}</span>
    </span>
  );
}

export function RiskIndicator({ risk }: { readonly risk: string }): ReactNode {
  const label =
    risk === 'destructive'
      ? 'Destructive'
      : risk === 'sensitive_write'
        ? 'Sensitive write'
        : risk === 'external_side_effect'
          ? 'External side effect'
          : risk === 'reversible_write'
            ? 'Reversible write'
            : 'Read';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span aria-hidden="true">{risk === 'read' ? '○' : '▲'}</span>
      <span>{label}</span>
    </span>
  );
}

export function SkipLink(): ReactNode {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-[var(--bg-elevated)] focus:px-4 focus:py-3"
    >
      Skip to main content
    </a>
  );
}

export function Button({
  children,
  type = 'button',
  onClick,
  disabled,
  tone = 'primary',
  href,
}: {
  readonly children: ReactNode;
  readonly type?: 'button' | 'submit' | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly tone?: 'primary' | 'neutral' | 'danger' | undefined;
  readonly href?: string | undefined;
}): ReactNode {
  const palette =
    tone === 'danger'
      ? 'bg-[var(--danger)] text-white'
      : tone === 'neutral'
        ? 'border border-[var(--line)] bg-[var(--bg-elevated)] text-[var(--ink)]'
        : 'bg-[var(--accent)] text-[var(--accent-ink)]';
  const className = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-4 text-sm font-medium ${palette} disabled:opacity-50`;
  if (href !== undefined) {
    return (
      <a className={className} href={disabled === true ? undefined : href} aria-disabled={disabled}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} className={className} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined ? (
          <p className="mt-1 text-[var(--muted)]">{description}</p>
        ) : null}
      </div>
      {actions}
    </header>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-6">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-2 text-[var(--muted)]">{body}</p>
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { readonly className?: string }): ReactNode {
  return (
    <div
      className={`animate-pulse rounded bg-[var(--line)] ${className ?? 'h-24'}`}
      aria-hidden="true"
    />
  );
}

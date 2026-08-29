import type { ReactNode } from 'react';

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'bg-[var(--muted)]' },
  running: { label: 'Running', tone: 'bg-[var(--accent)]' },
  waiting_for_approval: { label: 'Waiting for approval', tone: 'bg-[var(--warn)]' },
  resuming: { label: 'Resuming', tone: 'bg-[var(--accent)]' },
  verifying: { label: 'Verifying', tone: 'bg-[var(--accent)]' },
  completed: { label: 'Completed', tone: 'bg-[var(--ok)]' },
  failed: { label: 'Failed', tone: 'bg-[var(--danger)]' },
  cancelled: { label: 'Cancelled', tone: 'bg-[var(--muted)]' },
  rejected: { label: 'Rejected', tone: 'bg-[var(--danger)]' },
  timed_out: { label: 'Timed out', tone: 'bg-[var(--danger)]' },
  pending: { label: 'Pending', tone: 'bg-[var(--warn)]' },
  approved: { label: 'Approved', tone: 'bg-[var(--ok)]' },
  stale: { label: 'Stale', tone: 'bg-[var(--warn)]' },
  expired: { label: 'Expired', tone: 'bg-[var(--muted)]' },
  ready: { label: 'Ready', tone: 'bg-[var(--ok)]' },
  degraded: { label: 'Degraded', tone: 'bg-[var(--danger)]' },
  unknown: { label: 'Unknown', tone: 'bg-[var(--muted)]' },
};

export function StatusBadge({
  status,
  label,
}: {
  readonly status: string;
  readonly label?: string;
}): ReactNode {
  const meta = STATUS_COPY[status] ?? { label: label ?? status, tone: 'bg-[var(--muted)]' };
  const textTone =
    status === 'ready' || status === 'completed' || status === 'approved'
      ? 'text-[var(--ok)]'
      : status === 'failed' || status === 'rejected' || status === 'degraded'
        ? 'text-[var(--danger)]'
        : status === 'waiting_for_approval' || status === 'pending'
          ? 'text-[var(--warn)]'
          : 'text-[var(--muted)]';
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-medium ${textTone}`}>
      <span className={`size-2 shrink-0 rounded-full ${meta.tone}`} aria-hidden="true" />
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
  const tone =
    risk === 'destructive' || risk === 'sensitive_write'
      ? 'text-[var(--danger)]'
      : risk === 'external_side_effect'
        ? 'text-[var(--warn)]'
        : 'text-[var(--muted)]';
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-medium ${tone}`}>
      <span className="size-2 rounded-full bg-current opacity-80" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function SkipLink(): ReactNode {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--bg-elevated)] focus:px-4 focus:py-3 focus:shadow-[var(--shadow-md)]"
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
  size = 'md',
}: {
  readonly children: ReactNode;
  readonly type?: 'button' | 'submit' | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly tone?: 'primary' | 'neutral' | 'danger' | undefined;
  readonly href?: string | undefined;
  readonly size?: 'md' | 'lg' | undefined;
}): ReactNode {
  const palette =
    tone === 'danger'
      ? 'border border-transparent bg-[var(--danger)] text-white shadow-sm hover:brightness-110'
      : tone === 'neutral'
        ? 'border border-[var(--line)] bg-[var(--bg-elevated)] text-[var(--ink)] shadow-sm hover:border-[var(--accent)] hover:text-[var(--accent)]'
        : 'border border-transparent bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow-accent)] hover:bg-[var(--accent-hover)]';
  const sizing = size === 'lg' ? 'min-h-12 px-7 text-base' : 'min-h-10 px-5 text-sm';
  const className = `inline-flex min-w-10 items-center justify-center rounded-[var(--radius-pill)] font-medium transition ${sizing} ${palette} disabled:opacity-50 disabled:pointer-events-none`;
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
    <header className="mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="font-[family-name:var(--font-display)] text-[2.125rem] font-semibold leading-tight tracking-[-0.03em] sm:text-[2.5rem]">
          {title}
        </h1>
        {description !== undefined ? (
          <p className="mt-3 text-base text-[var(--muted)] leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={`surface-soft rounded-[var(--radius-lg)] ${className ?? ''}`}>{children}</div>;
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
    <Card className="p-10 text-center sm:text-left">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold tracking-[-0.02em]">
        {title}
      </h2>
      <p className="mt-2 max-w-prose text-[var(--muted)]">{body}</p>
      {action !== undefined ? <div className="mt-6">{action}</div> : null}
    </Card>
  );
}

export function Skeleton({ className }: { readonly className?: string }): ReactNode {
  return (
    <div
      className={`animate-pulse rounded-[var(--radius)] bg-[var(--line)] ${className ?? 'h-24'}`}
      aria-hidden="true"
    />
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'accent' | 'warn' | undefined;
}): ReactNode {
  const palette =
    tone === 'accent'
      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
      : tone === 'warn'
        ? 'bg-[var(--warn-soft)] text-[var(--warn)]'
        : 'bg-[var(--bg-muted)] text-[var(--muted)]';
  return (
    <span className={`inline-flex items-center rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium ${palette}`}>
      {children}
    </span>
  );
}

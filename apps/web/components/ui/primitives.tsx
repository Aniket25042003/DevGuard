import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

const STATUS_COPY: Record<string, { label: string; tone: string; icon: IconName }> = {
  queued: { label: 'Queued', tone: 'info', icon: 'clock' },
  dispatch_pending: { label: 'Dispatch pending', tone: 'info', icon: 'clock' },
  running: { label: 'Running', tone: 'accent', icon: 'activity' },
  waiting_for_approval: { label: 'Needs approval', tone: 'warn', icon: 'alert' },
  resuming: { label: 'Resuming', tone: 'accent', icon: 'activity' },
  verifying: { label: 'Verifying', tone: 'accent', icon: 'shield' },
  completed: { label: 'Completed', tone: 'ok', icon: 'check' },
  failed: { label: 'Failed', tone: 'danger', icon: 'x' },
  blocked: { label: 'Blocked', tone: 'danger', icon: 'shield' },
  unavailable: { label: 'Unavailable', tone: 'danger', icon: 'alert' },
  cancelling: { label: 'Cancelling', tone: 'warn', icon: 'clock' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'x' },
  rejected: { label: 'Rejected', tone: 'danger', icon: 'x' },
  timed_out: { label: 'Timed out', tone: 'danger', icon: 'clock' },
  pending: { label: 'Pending', tone: 'warn', icon: 'clock' },
  approved: { label: 'Approved', tone: 'ok', icon: 'check' },
  stale: { label: 'Stale', tone: 'warn', icon: 'alert' },
  expired: { label: 'Expired', tone: 'neutral', icon: 'clock' },
  ready: { label: 'Ready', tone: 'ok', icon: 'check' },
  degraded: { label: 'Degraded', tone: 'warn', icon: 'alert' },
  unknown: { label: 'Unknown', tone: 'neutral', icon: 'alert' },
};

export function StatusBadge({
  status,
  label,
  showIcon = true,
}: {
  readonly status: string;
  readonly label?: string;
  readonly showIcon?: boolean;
}): ReactNode {
  const meta = STATUS_COPY[status] ?? {
    label: label ?? status,
    tone: 'neutral',
    icon: 'alert' as const,
  };
  return (
    <span className={`status-badge status-badge-${meta.tone}`} data-status={status}>
      {showIcon ? <Icon name={meta.icon} size={14} /> : null}
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
            : 'Read only';
  const tone =
    risk === 'destructive' || risk === 'sensitive_write'
      ? 'danger'
      : risk === 'external_side_effect'
        ? 'warn'
        : 'neutral';
  return (
    <span className={`risk-indicator risk-indicator-${tone}`}>
      <Icon name="shield" size={14} />
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
  icon,
  loading = false,
}: {
  readonly children: ReactNode;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'primary' | 'neutral' | 'danger' | 'ghost';
  readonly href?: string | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly icon?: IconName;
  readonly loading?: boolean;
}): ReactNode {
  const className = `button button-${tone} button-${size}`;
  const content = (
    <>
      {loading ? (
        <span className="button-spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      ) : null}
      <span>{children}</span>
    </>
  );
  if (href !== undefined) {
    if (disabled)
      return (
        <span className={`${className} button-disabled`} aria-disabled="true">
          {content}
        </span>
      );
    return (
      <Link href={href} className={className} {...(onClick === undefined ? {} : { onClick })}>
        {content}
      </Link>
    );
  }
  return (
    <button type={type} className={className} onClick={onClick} disabled={disabled || loading}>
      {content}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  onClick,
  href,
  disabled,
}: {
  readonly label: string;
  readonly icon: IconName;
  readonly onClick?: () => void;
  readonly href?: string;
  readonly disabled?: boolean;
}): ReactNode {
  const className = 'icon-button';
  const content = <Icon name={icon} size={18} label={label} />;
  if (href !== undefined)
    return (
      <Link href={href} className={className} aria-label={label}>
        {content}
      </Link>
    );
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {content}
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
    <header className="page-header">
      <div className="min-w-0">
        <h1>{title}</h1>
        {description ? <p className="page-header-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return <div className={`surface-soft rounded-[var(--radius-lg)] ${className}`}>{children}</div>;
}

export function EmptyState({
  title,
  body,
  action,
  icon = 'repo',
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
  readonly icon?: IconName;
}): ReactNode {
  return (
    <Card className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} size={20} />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </Card>
  );
}

export function Skeleton({ className = 'h-24' }: { readonly className?: string }): ReactNode {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Badge({
  children,
  tone = 'neutral',
  icon,
}: {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok';
  readonly icon?: IconName;
}): ReactNode {
  return (
    <span className={`badge badge-${tone}`}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

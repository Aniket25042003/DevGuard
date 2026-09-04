import type { ReactNode } from 'react';

export type IconName =
  | 'activity'
  | 'alert'
  | 'arrow-up-right'
  | 'check'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'code'
  | 'external'
  | 'github'
  | 'home'
  | 'menu'
  | 'play'
  | 'plus'
  | 'repo'
  | 'shield'
  | 'sliders'
  | 'spark'
  | 'terminal'
  | 'x';

const PATHS: Record<IconName, ReactNode> = {
  activity: (
    <>
      <path d="M3 12h4l2.2-7 4.1 14L16 12h5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.7 19h18.6L12 3Z" />
      <path d="M12 9v4" />
      <path d="M12 16h.01" />
    </>
  ),
  'arrow-up-right': (
    <>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </>
  ),
  check: <path d="m5 12 4.2 4L19 6" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
      <path d="m14 4-4 16" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="m19 5-8 8" />
      <path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
    </>
  ),
  github: (
    <>
      <path d="M9 19c-4 .9-4-2-5.6-2.5M14.6 21v-3.5a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-5.9a4.6 4.6 0 0 0-1.2-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.2a11.6 11.6 0 0 0-6.2 0C6 2.6 5 2.9 5 2.9a4.3 4.3 0 0 0-.1 3.2 4.6 4.6 0 0 0-1.2 3.2c0 4.6 2.8 5.6 5.5 5.9a2.6 2.6 0 0 0-.8 1.7V21" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7" />
      <path d="M5 9v10h14V9" />
      <path d="M9 19v-6h6v6" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  play: <path d="m9 5 10 7-10 7V5Z" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  repo: (
    <>
      <path d="M5 4h10l4 4v12H5z" />
      <path d="M15 4v5h4" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 19 6v5c0 4.6-2.9 8.2-7 10-4.1-1.8-7-5.4-7-10V6l7-3Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="11" cy="18" r="2" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" />
      <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" />
    </>
  ),
  terminal: (
    <>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  label,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly label?: string;
  readonly className?: string;
}): ReactNode {
  return (
    <svg
      aria-hidden={label === undefined}
      aria-label={label}
      className={className}
      fill="none"
      height={size}
      role={label === undefined ? undefined : 'img'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      {PATHS[name]}
    </svg>
  );
}

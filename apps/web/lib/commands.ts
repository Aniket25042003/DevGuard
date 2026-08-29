import type { OriginSurface } from '@devguard/api-contracts';
import { APP_HOME_PATH } from '@/features/navigation/routes';

export const COMMAND_BUTTONS = [
  {
    commandId: 'review_remediation',
    label: 'Review PR',
    description: 'Remediate review findings on a pull request.',
  },
  {
    commandId: 'diagnose_failure',
    label: 'Fix failure',
    description: 'Diagnose a failing check and propose a bounded repair.',
  },
  {
    commandId: 'security_audit',
    label: 'Security audit',
    description: 'Run a provenance-aware security audit.',
  },
  {
    commandId: 'security_patch',
    label: 'Patch findings',
    description: 'Patch eligible security findings and re-scan.',
  },
  {
    commandId: 'implement_issue',
    label: 'Implement issue',
    description: 'Implement a GitHub issue through the governed workflow.',
  },
] as const;

export type LauncherCommandId = (typeof COMMAND_BUTTONS)[number]['commandId'];

export const ORIGIN_LABELS: Readonly<Record<OriginSurface, string>> = {
  web: 'Web',
  cli: 'CLI',
  github_comment: 'GitHub',
  github_event: 'GitHub',
  schedule: 'Schedule',
};

export function originLabel(surface: string | undefined): string {
  if (surface === 'web') return ORIGIN_LABELS.web;
  if (surface === 'cli') return ORIGIN_LABELS.cli;
  if (surface === 'github_comment' || surface === 'github_event')
    return ORIGIN_LABELS.github_comment;
  if (surface === 'schedule') return ORIGIN_LABELS.schedule;
  return surface ?? 'Unknown';
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replaceAll('-', '');
  }
  return `web${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

export function validateReturnTo(candidate: string | null | undefined): string {
  if (candidate === undefined || candidate === null || candidate === '') return APP_HOME_PATH;
  if (candidate === '/') return APP_HOME_PATH;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return APP_HOME_PATH;
  if (candidate.includes('://') || candidate.includes('\\')) return APP_HOME_PATH;
  return candidate;
}

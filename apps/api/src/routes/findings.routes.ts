/**
 * C073 — security findings routes.
 *
 * GET /api/v1/workflows/:runId/security-findings  normalized stable findings.
 *
 * Findings are untrusted scanner output normalized by the C051/C052 layer; this
 * route surfaces only the normalized stable findings (id/severity/status/refs),
 * never raw scanner text or secrets. Session-required.
 */
import type { FindingSeverity, FindingStatus } from '@devguard/contracts';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@devguard/api-contracts';
import { validationFailed } from '@devguard/errors';
import type { RegisterV1Route } from '../transport/kernel.js';

export interface SecurityFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly rule?: string | undefined;
}

export interface FindingsPort {
  listFor(runId: string): Promise<readonly SecurityFinding[]>;
}

export function registerFindingsRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  findings: FindingsPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId/security-findings',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined)
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      const list = await findings.listFor(c.req.param('runId') ?? '');
      return c.json({ findings: list });
    },
  );
}

export type RemediationSubmitPort = (input: {
  findingId: string;
  idempotencyKey: string;
  surface: 'web' | 'cli';
}) => Promise<{ ok: true; runId: string } | { ok: false; code: string; detail: string }>;

/**
 * CP015 (C071) — start a remediation command from a finding.
 * Delegates to the shared command bus (CP006); the finding id is the opaque
 * reference the remediation step uses.
 */
export function registerFindingsRemediationRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  submit: RemediationSubmitPort,
): void {
  kernel.registerV1Route(
    'post',
    '/api/v1/findings/:id/remediation',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined) {
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      }
      const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
      if (idempotencyKey === undefined) {
        return c.json(
          {
            error: {
              code: 'PRECONDITION_REQUIRED',
              message: 'idempotency-key header is required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          428,
        );
      }
      const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
        if (!parsedKey.success) {
          throw validationFailed([{ path: IDEMPOTENCY_KEY_HEADER, constraint: 'valid idempotency key required' }]);
        }
        const outcome = await submit({
        findingId: c.req.param('id') ?? '',
        idempotencyKey,
        surface: (c.req.header('origin') ?? '').includes('cli.') ? 'cli' : 'web',
      });
      if (!outcome.ok) {
        return c.json(
          {
            error: {
              code: outcome.code,
              message: outcome.detail,
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          outcome.code === 'COMMAND_UNKNOWN' ? 403 : 400,
        );
      }
      return c.json({ started: true, runId: outcome.runId });
    },
  );
}

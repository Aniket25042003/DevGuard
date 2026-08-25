/**
 * C003 — Framework-transport integration helpers.
 *
 * These are the ONLY functions an HTTP layer (C005) or worker runtime (C057)
 * needs for error handling. They contain no framework imports; adapters wire
 * them into the chosen transport.
 */
import { normalizeError } from './normalize.js';
import { httpStatusForCode, toErrorEnvelope } from './present.js';
import type { ErrorEnvelope } from './present.js';
import { toJobDisposition } from './job-disposition.js';
import type { JobDisposition } from './job-disposition.js';

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
}

/** Map any thrown value to the stable {status, body} error response. */
export function presentHttpError(error: unknown, requestId: string): HttpErrorResponse {
  const envelope = toErrorEnvelope(normalizeError(error), requestId);
  return { status: httpStatusForCode(envelope.error.code), body: envelope };
}

export type JobRunResult<T> =
  | { readonly outcome: 'completed'; readonly value: T }
  | { readonly outcome: 'failed'; readonly disposition: JobDisposition };

/**
 * Execute a job handler and translate failures into stable dispositions.
 * Handlers throw; this wrapper never swallows success values.
 */
export async function runJobWithDisposition<T>(
  handler: () => Promise<T>,
): Promise<JobRunResult<T>> {
  try {
    const value = await handler();
    return { outcome: 'completed', value };
  } catch (error: unknown) {
    return { outcome: 'failed', disposition: toJobDisposition(error) };
  }
}

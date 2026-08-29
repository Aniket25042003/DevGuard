import { apiErrorEnvelopeSchema } from '@devguard/api-contracts';

/**
 * Typed API failure. Feature code must not parse status text or invent codes.
 * `requestId` is always shown on C088 surfaces.
 */
export class DevGuardApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly details?: unknown;
  }) {
    super(input.message);
    this.name = 'DevGuardApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.status = input.status;
    this.retryable = input.retryable;
    this.details = input.details;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === 'UNAUTHENTICATED';
  }

  get isForbidden(): boolean {
    return this.status === 403 || this.code === 'REPOSITORY_FORBIDDEN';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409 || this.status === 412;
  }

  get mutationOutcomeUnknown(): boolean {
    return this.status === 0 || this.code === 'NETWORK_UNCERTAIN';
  }
}

export function decodeApiError(
  status: number,
  body: unknown,
  fallbackRequestId: string,
): DevGuardApiError {
  const parsed = apiErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return new DevGuardApiError({
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      requestId: parsed.data.error.requestId,
      status,
      retryable: parsed.data.error.retryable,
      ...(parsed.data.error.details !== undefined ? { details: parsed.data.error.details } : {}),
    });
  }
  return new DevGuardApiError({
    code: status === 0 ? 'NETWORK_UNCERTAIN' : 'UNKNOWN_TRANSPORT_ERROR',
    message:
      status === 0
        ? 'The request did not complete. Check whether the action finished before retrying.'
        : 'The server returned an unexpected error envelope.',
    requestId: fallbackRequestId,
    status,
    retryable: status >= 500 || status === 429 || status === 0,
  });
}

export function isDevGuardApiError(error: unknown): error is DevGuardApiError {
  return error instanceof DevGuardApiError;
}

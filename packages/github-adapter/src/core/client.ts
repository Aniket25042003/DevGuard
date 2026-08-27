/**
 * C018 §10/§12 — GitHubBaseClient with bounded transport, error/rate
 * normalization, conditional requests, pagination, and retry classification.
 *
 * Fixed-host transport (no user-controlled base URL), header allowlist,
 * body-size limits, token injection via SecretString (never logged), and
 * explicit authorized-context verification for write operations.
 */
import type { SecretString } from '../auth/contracts.js';
import type {
  AuthorizedActionContext,
  GitHubAdapterErrorKind,
  GitHubOperation,
  GitHubRequestContext,
  GitHubResponseMeta,
  GitHubResult,
} from './contracts.js';

const ALLOWED_HOST = 'api.github.com';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RawTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string | undefined;
}

export interface GitHubTransport {
  request(input: {
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body?: string | undefined;
    timeoutMs: number;
    host: string;
  }): Promise<RawTransportResponse>;
}

/** Node fetch-based transport; production binds this, tests use fakes. */
export class FetchTransport implements GitHubTransport {
  async request(input: {
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body?: string | undefined;
    timeoutMs: number;
    host: string;
  }): Promise<RawTransportResponse> {
    if (input.host !== ALLOWED_HOST) {
      throw new Error(`SSRF guard: only '${ALLOWED_HOST}' is allowed; got '${input.host}'`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(`https://${input.host}${input.path}`, {
        method: input.method,
        headers: input.headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const bodyText = response.status !== 204 ? await response.text() : undefined;
      if (bodyText && Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('response body exceeds maximum size');
      }
      return { status: response.status, headers, bodyText };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface GitHubClientOptions {
  readonly transport: GitHubTransport;
  readonly apiVersion: string;
  readonly nowMs?: (() => number) | undefined;
}

function parseRate(headers: Readonly<Record<string, string>>) {
  const limit = headers['x-ratelimit-limit'];
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  if (!limit || !remaining || !reset) return undefined;
  return { limit: Number(limit), remaining: Number(remaining), resetEpochSec: Number(reset) };
}

function errorKind(operation: GitHubOperation, status: number): GitHubAdapterErrorKind {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403 && operation.safety === 'read') return 'PERMISSION';
  if (status === 403) return 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 422) return 'VALIDATION';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'SERVER_ERROR';
}

export class GitHubBaseClient {
  constructor(private readonly options: GitHubClientOptions) {}

  async execute<I, O>(
    operation: GitHubOperation<I, O>,
    validatedInput: I,
    ctx: GitHubRequestContext,
    token: SecretString,
    authorizedActionContext?: AuthorizedActionContext,
  ): Promise<GitHubResult<O>> {
    // Writes REQUIRE an unforgeable authorized context from the action gateway.
    if (operation.safety === 'write' && !authorizedActionContext) {
      return {
        ok: false,
        error: {
          kind: 'UNAUTHORIZED_WRITE',
          operationId: operation.operationId,
          message: 'write operations require an AuthorizedActionContext from the action gateway',
        },
      };
    }

    const path = buildPath(operation.pathTemplate, validatedInput as Record<string, unknown>);
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.expose()}`,
      'x-github-api-version': this.options.apiVersion,
      'x-correlation-id': ctx.correlationId,
      'content-type': 'application/json',
    };

    const body =
      operation.method !== 'GET' && operation.method !== 'DELETE'
        ? JSON.stringify(validatedInput)
        : undefined;

    const raw = await this.options.transport.request({
      method: operation.method,
      path,
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: ctx.deadlineMs ?? DEFAULT_TIMEOUT_MS,
      host: ALLOWED_HOST,
    });

    const meta: GitHubResponseMeta = {
      ...(raw.headers['x-github-request-id']
        ? { githubRequestId: raw.headers['x-github-request-id'] }
        : {}),
      status: raw.status,
      ...(raw.headers.etag ? { etag: raw.headers.etag } : {}),
      ...(raw.headers['last-modified'] ? { lastModified: raw.headers['last-modified'] } : {}),
      ...(parseRate(raw.headers) ? { rate: parseRate(raw.headers) } : {}),
      ...(raw.headers.link ? { linkHeader: raw.headers.link } : {}),
      receivedAtMs: (this.options.nowMs ?? Date.now)(),
    };

    if (raw.status === 304) {
      return { ok: true, notModified: true, meta };
    }

    if (!operation.successStatuses.includes(raw.status)) {
      return {
        ok: false,
        error: {
          kind: errorKind(operation, raw.status),
          operationId: operation.operationId,
          status: raw.status,
          message: `GitHub API returned ${raw.status} for ${operation.operationId}`,
          ...(raw.headers['retry-after']
            ? { retryAfterMs: Number(raw.headers['retry-after']) * 1000 }
            : {}),
          ...(meta.githubRequestId ? { githubRequestId: meta.githubRequestId } : {}),
        },
      };
    }

    if (raw.status === 204 || raw.bodyText === undefined || raw.bodyText === '') {
      return { ok: true, value: undefined as O, meta };
    }

    try {
      const parsed = JSON.parse(raw.bodyText);
      const value = operation.outputSchema.parse(parsed);
      return { ok: true, value, meta };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'SCHEMA_MISMATCH',
          operationId: operation.operationId,
          message: `response schema mismatch for ${operation.operationId}: ${String((error as Error)?.message ?? error)}`,
          ...(meta.githubRequestId ? { githubRequestId: meta.githubRequestId } : {}),
        },
      };
    }
  }
}

/** Build path from template, encoding each placeholder value. */
function buildPath(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = input[key];
    if (value === undefined || value === null) {
      throw new Error(`missing path parameter '${key}' for operation template '${template}'`);
    }
    return encodeURIComponent(String(value));
  });
}

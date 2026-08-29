#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * CP017 — DevGuard terminal client over /api/v1 (C069: "same API as the UI").
 *
 * Thin fetch client only: no Octokit, no TrueForge, no SQL, no policy copies.
 * The repo flag is an identifier resolved via the API catalog. `originSurface`
 * is always set to `cli` by the client; the server accepts cli|web only from
 * HTTP (CP006). Credentials live in ~/.config/devguard/credentials.json (0600);
 * `DEVGUARD_TOKEN`/`DEVGUARD_API_BASE` are preferred over the file.
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CREDENTIALS_PATH = () => join(homedir(), '.config', 'devguard', 'credentials.json');

interface Credentials {
  apiBase: string;
  token: string;
}

interface ApiResult {
  status: number;
  data: unknown;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface CliDeps {
  fetchImpl: FetchLike;
  env: NodeJS.ProcessEnv;
  cwd: string;
  ctimeMs: () => number;
}

/** Canonical command verbs → CP001 workflow ids (no extra workflows). */
export const COMMAND_ID_BY_VERB: Readonly<Record<string, string>> = {
  review: 'review_remediation',
  fix: 'diagnose_failure',
  audit: 'security_audit',
  patch: 'security_patch',
  implement: 'implement_issue',
};

export async function loadCredentials(env: NodeJS.ProcessEnv): Promise<Credentials | undefined> {
  const envToken = env['DEVGUARD_TOKEN'];
  if (envToken !== undefined && envToken.length > 0) {
    return { apiBase: env['DEVGUARD_API_BASE'] ?? 'http://127.0.0.1:8080', token: envToken };
  }
  try {
    const raw = await readFile(CREDENTIALS_PATH(), 'utf8');
    const parsed = JSON.parse(raw) as { apiBase?: unknown; token?: unknown };
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return undefined;
    return {
      apiBase: typeof parsed.apiBase === 'string' ? parsed.apiBase : 'http://127.0.0.1:8080',
      token: parsed.token,
    };
  } catch {
    return undefined;
  }
}

export async function saveCredentials(value: Credentials): Promise<void> {
  const path = CREDENTIALS_PATH();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function removeCredentials(): Promise<void> {
  await rm(CREDENTIALS_PATH(), { force: true });
}

/** Token never appears in argv or output — only a safe prefix is ever printed. */
function safeTokenToken(token: string): string {
  return token.length <= 8 ? '***' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export class DevguardClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(credentials: Credentials, deps: Pick<CliDeps, 'fetchImpl'>) {
    this.base = credentials.apiBase.replace(/\/+$/, '');
    this.token = credentials.token;
    this.fetchImpl = deps.fetchImpl;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResult> {
    const res = await this.fetchImpl(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  }

  async repositories(): Promise<ApiResult> {
    return this.request('GET', '/repositories');
  }

  async commands(repositoryId: string): Promise<ApiResult> {
    return this.request('GET', `/repositories/${repositoryId}/commands`);
  }

  async submit(
    repositoryId: string,
    input: {
      command: string;
      idempotencyKey: string;
      prNumber?: number;
      checkRunId?: string;
      issueNumber?: number;
      findingIds?: string[];
      message?: string;
      ref?: string;
    },
  ): Promise<ApiResult> {
    return this.request('POST', `/repositories/${repositoryId}/commands`, {
      command: input.command,
      originSurface: 'cli',
      idempotencyKey: input.idempotencyKey,
      ...(input.prNumber !== undefined ? { pullRequestNumber: input.prNumber } : {}),
      ...(input.checkRunId !== undefined ? { checkRunId: input.checkRunId } : {}),
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      ...(input.findingIds !== undefined ? { findingIds: input.findingIds } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    });
  }

  async runsList(
    repositoryId: string,
    originSurface?: string,
    prNumber?: number,
  ): Promise<ApiResult> {
    const qs = new URLSearchParams();
    if (originSurface !== undefined) qs.set('originSurface', originSurface);
    if (prNumber !== undefined) qs.set('pullRequestNumber', String(prNumber));
    const suffix = qs.toString();
    return this.request(
      'GET',
      `/repositories/${repositoryId}/workflows${suffix !== '' ? `?${suffix}` : ''}`,
    );
  }

  async runShow(runId: string): Promise<ApiResult> {
    return this.request('GET', `/workflows/${runId}`);
  }

  async runCancel(runId: string, ifMatch: string): Promise<ApiResult> {
    return this.request('POST', `/workflows/${runId}/cancel`, undefined, { 'if-match': ifMatch });
  }

  async approvals(runId: string): Promise<ApiResult> {
    return this.request('GET', `/workflows/${runId}/approvals`);
  }

  async decide(
    runId: string,
    approvalId: string,
    action: 'approve' | 'reject',
  ): Promise<ApiResult> {
    return this.request('POST', `/workflows/${runId}/approvals/${approvalId}`, { action });
  }
}

export interface CliResult {
  exitCode: number;
  lines: string[];
}

export async function runCli(args: string[], deps: CliDeps): Promise<CliResult> {
  const out: string[] = [];
  const [verb0, ...rest] = args;
  const flag = (name: string): string | undefined => {
    const i = rest.findIndex((a) => a === name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const has = (name: string): boolean => rest.includes(name);
  const json = has('--json');
  const idempotencyKey = flag('--idempotency-key') ?? randomUUID();

  const print = (obj: unknown, human: string | undefined): void => {
    if (json) out.push(JSON.stringify(obj));
    else out.push(human ?? JSON.stringify(obj));
  };

  if (verb0 === undefined || verb0 === 'help' || verb0 === '--help') {
    out.push(HELP);
    return { exitCode: 0, lines: out };
  }

  if (verb0 === 'login') {
    const token = flag('--token') ?? deps.env['DEVGUARD_TOKEN'];
    if (token === undefined) {
      out.push(
        'login: paste token via --token (or set DEVGUARD_TOKEN). Open https://<api>/api/v1/auth/login first.',
      );
      return { exitCode: 2, lines: out };
    }
    await saveCredentials({
      apiBase: deps.env['DEVGUARD_API_BASE'] ?? 'http://127.0.0.1:8080',
      token,
    });
    out.push('login: stored token.');
    return { exitCode: 0, lines: out };
  }

  if (verb0 === 'logout') {
    await removeCredentials();
    out.push('logout: removed credentials.');
    return { exitCode: 0, lines: out };
  }

  const creds = await loadCredentials(deps.env);
  if (creds === undefined) {
    out.push('not logged in — run: devguard login --token <dgv1_…>');
    return { exitCode: 1, lines: out };
  }
  const client = new DevguardClient(creds, deps);

  if (verb0 === 'whoami') {
    const r = await client.repositories();
    print(
      { ok: r.status < 300, apiBase: creds.apiBase, token: safeTokenToken(creds.token) },
      `api ${creds.apiBase}\nprincipal ${safeTokenToken(creds.token)}`,
    );
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }

  const repo = flag('--repo') ?? deps.env['DEVGUARD_REPO'];
  if (repo === undefined) {
    out.push('error: --repo owner/name (or DEVGUARD_REPO) is required for this command.');
    return { exitCode: 2, lines: out };
  }
  const resolved = await resolveRepository(client, repo);
  if (resolved === undefined) {
    out.push(`error: repository "${repo}" not found in the catalog.`);
    return { exitCode: 1, lines: out };
  }
  const repositoryId = resolved.id;

  if (verb0 === 'repos' && rest[0] === 'ls') {
    print({ id: repositoryId, fullName: repo }, `${repo}\t${repositoryId}`);
    return { exitCode: 0, lines: out };
  }

  if (verb0 === 'commands' && rest[0] === 'ls') {
    const r = await client.commands(repositoryId);
    print(r.data, JSON.stringify(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }

  const workflowVerb = COMMAND_ID_BY_VERB[verb0];
  if (workflowVerb !== undefined) {
    const prNumber = numberFlag(flag('--pr'));
    const checkRunId = flag('--check-run');
    const issueNumber = numberFlag(flag('--issue'));
    const findingIdsRaw = flag('--finding');
    const findingIds = findingIdsRaw !== undefined ? findingIdsRaw.split(',') : undefined;
    const message = flag('--message');
    const ref = flag('--ref');
    if (
      prNumber === undefined &&
      checkRunId === undefined &&
      issueNumber === undefined &&
      findingIds === undefined &&
      verb0 !== 'audit'
    ) {
      out.push(
        `error: ${verb0} needs one of --pr <n> | --check-run <id> | --issue <n> | --finding <id>,id`,
      );
      return { exitCode: 2, lines: out };
    }
    const r = await client.submit(repositoryId, {
      command: workflowVerb,
      idempotencyKey,
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(checkRunId !== undefined ? { checkRunId } : {}),
      ...(issueNumber !== undefined ? { issueNumber } : {}),
      ...(findingIds !== undefined ? { findingIds } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(ref !== undefined ? { ref } : {}),
    });
    if (r.status === 409) {
      out.push(`info: already submitted (409) — existing run.`);
      return { exitCode: 0, lines: out };
    }
    if (r.status >= 300) {
      out.push(`error: ${describeError(r.data)}`);
      return { exitCode: 1, lines: out };
    }
    const data = (r.data ?? {}) as { runId?: string };
    const runId = data.runId ?? 'unknown';
    print(
      { runId, status: 'submitted', originSurface: 'cli' },
      `submitted run ${runId} (origin: cli)`,
    );
    return { exitCode: 0, lines: out };
  }

  if (verb0 === 'runs' && rest[0] === 'ls') {
    const r = await client.runsList(repositoryId, flag('--origin'), numberFlag(flag('--pr')));
    print(r.data, humanRuns(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }
  if (verb0 === 'runs' && rest[0] === 'show') {
    const r = await client.runShow(rest[1] ?? '');
    print(r.data, JSON.stringify(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }
  if (verb0 === 'runs' && rest[0] === 'cancel') {
    const row = rest[1] ?? '';
    const version = String(flag('--if-match') ?? (await guessRowVersion(client, row)));
    const r = await client.runCancel(row, version);
    print(r.data, JSON.stringify(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }
  if (verb0 === 'runs' && rest[0] === 'watch') {
    const runId = rest[1] ?? '';
    for (let i = 0; i < 60; i += 1) {
      const r = await client.runShow(runId);
      const d = r.data as { status?: string };
      out.push(`run ${runId} status: ${d.status ?? 'unknown'}`);
      if (
        r.status >= 300 ||
        d.status === 'completed' ||
        d.status === 'failed' ||
        d.status === 'cancelled'
      )
        break;
      await new Promise((resolveFn) => setTimeout(resolveFn, 2000));
    }
    return { exitCode: 0, lines: out };
  }

  if (verb0 === 'approvals' && rest[0] === 'ls') {
    const r = await client.approvals(rest[1] ?? flag('--run') ?? '');
    print(r.data, JSON.stringify(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }
  if (verb0 === 'approvals' && rest[0] === 'decide') {
    const approvalId = rest[1] ?? '';
    const action = has('--approve') ? 'approve' : has('--reject') ? 'reject' : undefined;
    if (action === undefined) {
      out.push('error: approvals decide needs --approve or --reject');
      return { exitCode: 2, lines: out };
    }
    const r = await client.decide(flag('--run') ?? rest[2] ?? '', approvalId, action);
    print(r.data, JSON.stringify(r.data));
    return { exitCode: r.status < 300 ? 0 : 1, lines: out };
  }

  out.push(`devguard: unknown command "${[verb0, ...rest].join(' ')}". Try "devguard help".`);
  return { exitCode: 2, lines: out };
}

function numberFlag(v: string | undefined): number | undefined {
  const n = v === undefined ? undefined : Number(v);
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function resolveRepository(
  client: DevguardClient,
  repo: string,
): Promise<{ id: string } | undefined> {
  const r = await client.repositories();
  if (r.status >= 300) return undefined;
  const data = (r.data ?? {}) as {
    data?: { repositories?: Array<{ id?: string; fullName?: string }> };
  };
  const list = data.data?.repositories ?? [];
  const found = list.find((item) => item.fullName === repo || item.id === repo);
  return found?.id !== undefined ? { id: found.id } : undefined;
}

async function guessRowVersion(client: DevguardClient, runId: string): Promise<string> {
  const r = await client.runShow(runId);
  const d = r.data as { data?: { rowVersion?: number | string } };
  return String(d.data?.rowVersion ?? 1);
}

function humanRuns(data: unknown): string {
  const d = data as {
    data?: {
      runs?: Array<{ id?: string; workflowType?: string; status?: string; originSurface?: string }>;
    };
  };
  return (
    (d.data?.runs ?? [])
      .map(
        (run) => `${run.id}\t${run.status}\t${run.originSurface ?? ''}\t${run.workflowType ?? ''}`,
      )
      .join('\n') || '(no runs)'
  );
}

function describeError(data: unknown): string {
  const e = (data as { error?: { code?: string; message?: string } })?.error;
  return e !== undefined ? `${e.code ?? 'unknown'}: ${e.message ?? ''}` : 'request failed';
}

export const HELP = `devguard — DevGuard terminal client (/api/v1)

login|logout|whoami
repos ls --repo owner/name
commands ls --repo owner/name
review --pr <n>              (review_remediation)
fix    --pr <n>|--check-run <id>|--issue <n>
audit  [--ref <sha>]         (security_audit)
patch  --finding <id>[,id]   (security_patch)
implement --issue <n>        (implement_issue)
runs ls [--pr <n>] [--origin cli|web] --repo owner/name
runs show <runId> | runs cancel <runId> [--if-match <v>] | runs watch <runId>
approvals ls [--run <runId>] | decisions: approvals decide <approvalId> --approve|--reject [--run <runId>]

--json prints raw API JSON; --idempotency-key for scripts; DEVGUARD_TOKEN overrides the file.
Origin surface is always 'cli'; the server accepts cli|web over HTTP (CP006).
`;

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCli(argv, {
    fetchImpl: globalThis.fetch as unknown as FetchLike,
    env,
    cwd: process.cwd(),
    ctimeMs: () => Date.now(),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

// Run only when invoked as the bin (never when imported by tests).
const isEntry = process.argv[1] !== undefined && import.meta.url === urlToPath(process.argv[1]);
function urlToPath(entry: string): string {
  return entry.startsWith('file:') ? entry : `${urlPathToFileUrl(entry)}`;
}
function urlPathToFileUrl(p: string): string {
  return `file://${p.startsWith('/') ? p : `/${p}`}`;
}
if (isEntry) {
  void main(process.argv.slice(2), process.env);
}

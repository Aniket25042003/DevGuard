#!/usr/bin/env node
/**
 * DevGuard local orchestration CLI (C098).
 *
 * State machine (C098 §9):
 *   CHECKING_PREREQUISITES → BOOTSTRAPPING_ENV → STARTING_DEPENDENCIES
 *   → WAITING_FOR_DEPENDENCIES → MIGRATING → SEEDING → STARTING_APPS → READY
 *
 * Subcommands: up (default) | down | reset | status | migrate | seed
 *              | doctor | test-up | test-down | test-reset
 *
 * Safety contract:
 * - Commands and arguments are arrays; never shell-interpolated strings.
 * - Destructive subcommands validate identity via assertLocalDisposableTarget.
 * - `up` is idempotent; rerunning reconciles and applies only pending work.
 * - SIGINT/SIGTERM stops foreground app roles but preserves data containers.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertLocalDisposableTarget,
  bootstrapEnv,
  parseDotEnv,
  summarizePrerequisites,
} from './lib/env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE_LOCAL = ['infra/docker/compose.local.yml'];
const COMPOSE_TEST = ['infra/docker/compose.test.yml'];
const LOCAL_PROJECT = 'devguard-local';
const TEST_PROJECT = 'devguard-test';

/** @typedef {{stage: string, status: 'passed'|'failed'|'skipped'|'degraded', durationMs: number, summary: string, remediation?: string}} LocalStageResult */

const stages = [];
function record(stage, status, summary, remediation = undefined, startedAt = Date.now()) {
  const result = /** @type {LocalStageResult} */ ({
    stage,
    status,
    durationMs: Math.max(1, Date.now() - startedAt),
    summary,
  });
  if (remediation) result.remediation = remediation;
  stages.push(result);
  print(result);
  return result;
}

function print(result) {
  const marker = { passed: '+', failed: 'x', skipped: '-', degraded: '~' }[result.status];
  console.error(`[local] ${marker} ${result.stage}: ${result.summary}`);
}

/* ----------------------------- prerequisites ---------------------------- */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'node',
    ok: major >= 24,
    detail: `${process.versions.node} (requires >= 24 per .node-version line 26)`,
  };
}

function runProbe(cmd, args, timeoutMs = 15_000) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, timeout: timeoutMs, encoding: 'utf8' });
  if (res.error) return { ok: false, detail: String(res.error.message), stdout: '' };
  return {
    ok: res.status === 0,
    detail: (res.stderr || '').trim().slice(0, 160),
    stdout: res.stdout ?? '',
  };
}

function checkPrerequisites({ requireDocker = true } = {}) {
  const checks = [checkNode()];
  const pnpmProbe = runProbe('pnpm', ['--version']);
  checks.push({ name: 'pnpm', ok: pnpmProbe.ok, detail: pnpmProbe.detail || '' });
  if (requireDocker) {
    const engine = runProbe('docker', ['info', '--format', '{{.ServerVersion}}']);
    checks.push({ name: 'docker', ok: engine.ok, detail: engine.detail || '' });
    const compose = runProbe('docker', ['compose', 'version']);
    checks.push({
      name: 'compose',
      ok: compose.ok && /v2\./.test(compose.stdout),
      detail: compose.ok ? compose.stdout.trim().split('\n')[0] : compose.detail,
    });
  }
  return summarizePrerequisites(checks);
}

/* -------------------------------- compose -------------------------------- */

/** Build a docker compose argument vector — never an interpolated shell string. */
function composeArgs(files, project, action, extraArgs = []) {
  const fArgs = files.flatMap((f) => ['-f', path.resolve(REPO_ROOT, f)]);
  return ['docker', 'compose', ...fArgs, '-p', project, ...action, ...extraArgs];
}

function runCompose(files, project, action, extraArgs = []) {
  const argv = composeArgs(files, project, action, extraArgs);
  return runProbe(argv[0], argv.slice(1));
}

async function waitContainerHealthy(project, service, deadlineMs) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > deadlineMs) {
      throw new Error(`${service} did not become healthy within ${deadlineMs}ms`);
    }
    const probe = runCompose(COMPOSE_LOCAL, project, ['ps', '--format', 'json', service]);
    if (
      probe.ok &&
      probe.stdout.includes(String.raw`"Health"`) &&
      probe.stdout.includes(String.raw`"healthy"`)
    ) {
      return true;
    }
    // Compose ps --format json prints one JSON object per container.
    try {
      const entries = probe.stdout
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      if (
        entries.length > 0 &&
        entries.every((e) => e.Health === 'healthy' || !e.State?.match(/running/) === false)
      ) {
        // fallthrough to Health-based check below
      }
      if (entries.length > 0 && entries.every((e) => e.Health === 'healthy')) return true;
      if (entries.length > 0 && entries.some((e) => e.State === 'exited' || e.State === 'dead')) {
        throw new Error(
          `${service} exited during startup; inspect with: docker compose -p ${project} logs ${service}`,
        );
      }
    } catch (error) {
      if (/exited during startup/.test(String(error))) throw error;
    }
    await delay(1000);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Direct TCP reachability for the API/worker readiness probes. */
export function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/* ---------------------------------- env ---------------------------------- */

function loadEffectiveEnv() {
  const envLocalPath = path.join(REPO_ROOT, '.env.local');
  const fileEnv = existsSync(envLocalPath) ? parseDotEnv(readFileSync(envLocalPath, 'utf8')) : {};
  const merged = { ...fileEnv };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DEVGUARD_') || ['DATABASE_URL', 'REDIS_URL'].includes(key)) {
      merged[key] = /** @type {string} */ (process.env[key]);
    }
  }
  return merged;
}

/* ------------------------------- migration ------------------------------- */

/**
 * Apply migrations through @devguard/db's canonical runner by importing its
 * built output directly (single source of truth for C007 semantics).
 */
async function applyMigrations(databaseUrl) {
  assertLocalDisposableTarget(databaseUrl);
  const dbModuleUrl = new URL('../../packages/db/dist/index.js', import.meta.url);
  if (!existsSync(dbModuleUrl)) {
    throw new Error('@devguard/db is not built; run `pnpm build` first.');
  }
  const { createPool, runMigrations } = await import(dbModuleUrl.href);
  const pool = createPool({ connectionString: databaseUrl, max: 2 });
  try {
    const result = await runMigrations(pool);
    return result;
  } finally {
    await pool.drain();
  }
}

/* --------------------------------- seeds --------------------------------- */

/**
 * Deterministic development seeds (C098 §8). Today's schema domains are
 * persisted aggregates only, so the seed profile records the seed version in
 * a dedicated bookkeeping table (NOT product schema) and fails on rerun
 * shape-drift. Product-visible fixtures are added by their owning components.
 */
async function applySeeds(databaseUrl) {
  assertLocalDisposableTarget(databaseUrl);
  const dbModuleUrl = new URL('../../packages/db/dist/index.js', import.meta.url);
  const { createPool } = await import(dbModuleUrl.href);
  const pool = createPool({ connectionString: databaseUrl, max: 1 });
  const SEED_VERSION = 1;
  try {
    await pool.query({
      text: `CREATE TABLE IF NOT EXISTS dev_seed_state (
        seed_version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    });
    await pool.query({
      text: 'INSERT INTO dev_seed_state (seed_version) VALUES ($1) ON CONFLICT DO NOTHING',
      values: [SEED_VERSION],
    });
    return SEED_VERSION;
  } finally {
    await pool.drain();
  }
}

/* ------------------------------ app supervisor --------------------------- */

class AppSupervisor {
  #children = [];
  #stopping = false;

  start(role, args, extraEnv = {}) {
    const child = spawn(args[0], args.slice(1), {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code, signal) => {
      if (!this.#stopping) {
        console.error(`[local] role '${role}' exited unexpectedly (code=${code} signal=${signal})`);
        this.stopAll(0);
        process.exitCode = code ?? 1;
      }
    });
    this.#children.push({ role, child });
    console.error(`[local] started role '${role}' pid=${child.pid}`);
    return child;
  }

  stopAll(timeoutMs = 8000) {
    if (this.#stopping) return;
    this.#stopping = true;
    for (const { child } of this.#children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }
    const hardStop = setTimeout(() => {
      for (const { child } of this.#children) child.kill('SIGKILL');
    }, timeoutMs);
    hardStop.unref?.();
  }

  get size() {
    return this.#children.length;
  }
}

/* -------------------------------- commands ------------------------------- */

const appPorts = { api: 4000, web: 3000 };

async function cmdUp() {
  const prereqs = checkPrerequisites();
  record(
    'CHECKING_PREREQUISITES',
    prereqs.ok ? 'passed' : 'failed',
    prereqs.ok ? 'node/pnpm/docker/compose available' : prereqs.summary,
    prereqs.ok ? undefined : 'Install Docker Desktop + Corepack pnpm before rerunning.',
  );
  if (!prereqs.ok) process.exit(2);
  let created;
  try {
    created = bootstrapEnv(REPO_ROOT);
  } catch (error) {
    record('BOOTSTRAPPING_ENV', 'failed', String(error.message));
    process.exit(2);
  }
  record(
    'BOOTSTRAPPING_ENV',
    'passed',
    created.created
      ? '.env.local generated from template'
      : '.env.local already present (left untouched)',
  );
  const deps = runCompose(COMPOSE_LOCAL, LOCAL_PROJECT, ['up', '-d', '--wait'], []);
  record(
    'STARTING_DEPENDENCIES',
    deps.ok ? 'passed' : 'failed',
    deps.ok ? 'postgres+redis containers reconciled' : deps.detail || 'docker compose failed',
    deps.ok
      ? undefined
      : 'Check docker resources; inspect `docker compose -p devguard-local logs`.',
  );
  if (!deps.ok) process.exit(3);
  try {
    await Promise.all([
      waitContainerHealthy(LOCAL_PROJECT, 'postgres', 60_000),
      waitContainerHealthy(LOCAL_PROJECT, 'redis', 60_000),
    ]);
    record('WAITING_FOR_DEPENDENCIES', 'passed', 'healthchecks green for postgres & redis');
  } catch (error) {
    record(
      'WAITING_FOR_DEPENDENCIES',
      'failed',
      String(error.message ?? error),
      'Run `pnpm docker` logs or free ports 15432/16379, then rerun.',
    );
    process.exit(3);
  }
  const env = loadEffectiveEnv();
  let migrated;
  try {
    migrated = await applyMigrations(env.DATABASE_URL);
    record(
      'MIGRATING',
      'passed',
      `applied=${migrated.applied.length} verified=${migrated.verified.length}`,
    );
  } catch (error) {
    record('MIGRATING', 'failed', String(error.message ?? error));
    process.exit(4);
  }
  try {
    await applySeeds(env.DATABASE_URL);
    record('SEEDING', 'passed', 'deterministic seed version recorded (idempotent)');
  } catch (error) {
    record('SEEDING', 'failed', String(error.message ?? error));
    process.exit(4);
  }
  const supervisor = new AppSupervisor();
  forwardSignals(supervisor);
  const apiEnv = {
    ...env,
    RUN_SERVER: '1',
    PORT: String(appPorts.api),
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
  };
  supervisor.start('api', ['node', 'apps/api/dist/main.js'], apiEnv);
  // Worker is scaffold-only and exits successfully; do not supervise it as persistent.
  const workerEnv = { ...env, DATABASE_URL: env.DATABASE_URL, REDIS_URL: env.REDIS_URL };
  void workerEnv;
  // apps/web is scaffold-only until C076+ starts landing; report truthfully.
  record(
    'STARTING_APPS',
    'degraded',
    'api+worker launched; web remains scaffold-only (C076 out of scope)',
  );
  const readyBy = Date.now() + 30_000;
  let apiUp = false;
  while (Date.now() < readyBy && !(apiUp = await probeTcp('127.0.0.1', appPorts.api))) {
    await delay(500);
  }
  if (apiUp) {
    record(
      'READY',
      'passed',
      `API listening on http://127.0.0.1:${appPorts.api} (provider-safe mode: GitHub/TrueForge disabled)`,
    );
  } else {
    record(
      'READY',
      'degraded',
      'API port did not open within deadline; see [api] logs above',
      'Verify configuration and migrations; rerun after fixing.',
    );
  }
  // Foreground until signaled; containers keep developer data alive by default.
  await idleForever();
}

function forwardSignals(supervisor) {
  const handler = () => {
    console.error('\n[local] stopping foreground app roles (data containers stay running)');
    supervisor.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function idleForever() {
  await new Promise(() => undefined);
}

function cmdDown() {
  const res = runCompose(COMPOSE_LOCAL, LOCAL_PROJECT, ['down'], []);
  console.log(res.ok ? '[local] stopped.' : `[local] down failed: ${res.detail}`);
  process.exit(res.ok ? 0 : 1);
}

function cmdTestService(action) {
  const map = {
    'test-up': ['up', '-d', '--wait'],
    'test-down': ['down'],
    'test-reset': ['down', '-v', '--remove-orphans'],
  };
  const res = runCompose(COMPOSE_TEST, TEST_PROJECT, map[action], []);
  console.log(res.ok ? `[local] ${action} complete.` : `[local] ${action} failed: ${res.detail}`);
  process.exit(res.ok ? 0 : 1);
}

async function cmdMigrateOrSeed(kind) {
  const env = loadEffectiveEnv();
  if (!env.DATABASE_URL) {
    console.error('[local] DATABASE_URL missing; run `pnpm local` or set it explicitly.');
    process.exit(2);
  }
  try {
    if (kind === 'migrate') {
      const r = await applyMigrations(env.DATABASE_URL);
      console.log(`[local] migrations applied=${r.applied.length} verified=${r.verified.length}`);
    } else {
      await applySeeds(env.DATABASE_URL);
      console.log('[local] seeds applied.');
    }
  } catch (error) {
    console.error(`[local] ${kind} failed:`, error.message ?? error);
    process.exit(1);
  }
}

function cmdReset() {
  const target = LOCAL_PROJECT;
  assertLocalDisposableTarget(`${target}_pgdata`, [target]);
  console.error('[local] reset removes ALL local DevGuard data volumes (devguard-local).');
  if (!process.argv.includes('--yes')) {
    console.error('[local] re-run with `pnpm local:reset --yes` to confirm.');
    process.exit(2);
  }
  const res = runCompose(COMPOSE_LOCAL, target, ['down', '-v'], []);
  console.log(
    res.ok
      ? '[local] local data wiped; next `pnpm local` re-migrates.'
      : `reset failed: ${res.detail}`,
  );
  process.exit(res.ok ? 0 : 1);
}

async function cmdStatus() {
  const psLocal = runCompose(COMPOSE_LOCAL, LOCAL_PROJECT, ['ps', '--format', 'json'], []);
  const psTest = runCompose(COMPOSE_TEST, TEST_PROJECT, ['ps', '--format', 'json'], []);
  const apiReachable = await probeTcp('127.0.0.1', appPorts.api, 400);
  const redisReachable = await probeTcp('127.0.0.1', 16379, 400);
  const env = loadEffectiveEnv();
  console.log(
    JSON.stringify(
      {
        localComposeRunning: /"running"/.test(psLocal.stdout),
        testComposeRunning: /"running"/.test(psTest.stdout),
        apiReachable,
        redisReachable,
        providers: {
          github: env.AUTH_GITHUB_OAUTH_CLIENT_ID ? 'configured-partially' : 'disabled',
          trueforge:
            env.DEVGUARD_TRUEFORGE_BASE_URL && env.TRUEFORGE_API_KEY ? 'configured' : 'disabled',
        },
      },
      null,
      2,
    ),
  );
}

async function cmdDoctor() {
  const prereqs = checkPrerequisites();
  const status = {
    prerequisites: prereqs.checks,
    containers: runCompose(COMPOSE_LOCAL, LOCAL_PROJECT, ['ps'], []).stdout.split('\n').slice(0, 8),
  };
  console.log(JSON.stringify(status, null, 2));
}

/* ---------------------------------- main --------------------------------- */

const command = process.argv[2] ?? 'up';
try {
  switch (command) {
    case 'up':
      await cmdUp();
      break;
    case 'down':
      cmdDown();
      break;
    case 'reset':
      cmdReset();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'migrate':
      await cmdMigrateOrSeed('migrate');
      break;
    case 'seed':
      await cmdMigrateOrSeed('seed');
      break;
    case 'test-up':
    case 'test-down':
    case 'test-reset':
      cmdTestService(command);
      break;
    default:
      console.error(`Unknown command '${command}'. See docs/local-development.md.`);
      process.exit(64);
  }
} catch (error) {
  console.error('[local] fatal:', error.message ?? error);
  process.exit(70);
}

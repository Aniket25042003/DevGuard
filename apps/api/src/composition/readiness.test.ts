/**
 * CP002 §22/§23(8) — composition readiness and architecture tests.
 *
 * Proves the fail-closed binding matrix:
 *   - volatile (in-memory) adapters are refused outside `test` (or development
 *     with DEVGUARD_ALLOW_VOLATILE_AUTH=true),
 *   - a fully-durable binding set boots even in `production`,
 *   - the volatile workflow/webhook stores are defined ONLY in
 *     composition/volatile-adapters.ts and never in app.ts assembly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, type ApiConfigSnapshot } from '@devguard/config';
import {
  assembleApi,
  buildContainer,
  isVolatileBinding,
  validateReadiness,
  VolatileWebhookAcceptance,
  VolatileWorkflowService,
  type CompositionBindings,
} from '@devguard/api';
import type {
  AuthSessionRepository,
  AuthTransactionRepository,
  UserIdentityLinker,
} from '@devguard/auth';
import type { AuthorizationEvidencePort } from '@devguard/authorization';
import type { PolicySummaryPort } from '../routes/workflow.routes.js';
import type { RepositoryCatalogPort, WebhookAcceptancePort } from '../routes/github.routes.js';
import type { ArtifactPort } from '../routes/artifact.routes.js';
import type { AuditPort } from '../routes/audit.routes.js';
import type { FindingsPort } from '../routes/findings.routes.js';
import type { SessionPort } from '../routes/session.routes.js';
import type { ApprovalPort } from '../routes/approval.routes.js';

const ENV = {
  DEVGUARD_ENV: 'test',
  DATABASE_URL: 'postgres://localhost:5432/devguard',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_MODE: 'github_oauth',
  AUTH_SESSION_SECRET: 'session-secret-value-0123456789',
  AUTH_GITHUB_OAUTH_CLIENT_ID: 'Iv1.testclient',
  AUTH_GITHUB_OAUTH_CLIENT_SECRET: 'client-secret-value-0123456789',
  AUTH_GITHUB_OAUTH_CALLBACK_URL: 'http://localhost:4000/callback',
  DEVGUARD_PUBLIC_ORIGIN: 'https://devguard.example',
  DEVGUARD_ARTIFACT_DRIVER: 's3',
  DEVGUARD_S3_ENDPOINT: 'https://s3.example.com',
  DEVGUARD_S3_BUCKET: 'devguard-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
} as const;

/** Production/development without a real DSN — volatile adapters remain bound. */
const ENV_NO_DB = { ...ENV, DATABASE_URL: '<not-configured>' } as const;

function snapshot(
  environment: 'production' | 'development' | 'test',
  options: { readonly withDatabase?: boolean } = {},
): ApiConfigSnapshot {
  const base = options.withDatabase === false ? ENV_NO_DB : ENV;
  return loadConfig('api', { env: { ...base, DEVGUARD_ENV: environment } });
}

/** A binding set that is FULLY durable — nothing is in-memory, nothing pretends. */
const durableOverrides: Partial<CompositionBindings> = {
  sessions: {
    async insert() {},
    async findBySessionIdHash() {
      return undefined;
    },
    async touch() {},
    async revoke() {},
  } satisfies AuthSessionRepository,
  transactions: {
    async insert() {},
    async findByStateHash() {
      return undefined;
    },
    async consume() {},
  } satisfies AuthTransactionRepository,
  identities: {
    async resolve() {
      return 'user-durable';
    },
  } satisfies UserIdentityLinker,
  evidence: {
    async append() {},
    async findFresh() {
      return undefined;
    },
  } satisfies AuthorizationEvidencePort,
  workflows: {
    async launch() {
      return { ok: true, runId: 'run-1', replayed: false };
    },
    async statusOf() {
      return undefined;
    },
    async commandsOf() {
      return [];
    },
  },
  policies: {
    async summaryFor() {
      return [];
    },
  } satisfies PolicySummaryPort,
  webhooks: {
    async accept() {
      return { accepted: true };
    },
  } satisfies WebhookAcceptancePort,
  repositoryCatalog: {
    async listFor() {
      return [];
    },
  } satisfies RepositoryCatalogPort,
  artifacts: {
    async listFor() {
      return [];
    },
    async getSafe() {
      return undefined;
    },
  } satisfies ArtifactPort,
  audit: {
    async list() {
      return { verified: true, rows: [] };
    },
  } satisfies AuditPort,
  findings: {
    async listFor() {
      return [];
    },
  } satisfies FindingsPort,
  sessionEvents: {
    async get() {
      return undefined;
    },
    async events() {
      return [];
    },
    async eventsAfter() {
      return [];
    },
  } satisfies SessionPort,
  approvals: {
    async listFor() {
      return [];
    },
    async resolve() {
      return { ok: true };
    },
  } satisfies ApprovalPort,
};

describe('validateReadiness matrix (CP002 §22)', () => {
  it('refuses volatile default bindings in production', () => {
    const container = buildContainer(snapshot('production', { withDatabase: false }), {
      ...ENV_NO_DB,
    });
    expect(() => validateReadiness(container.config, container.bindings)).toThrow();
  });

  it('refuses an in-memory workflow port in production specifically', () => {
    const container = buildContainer(snapshot('production'), { ...ENV });
    const withInMemoryWorkflow: CompositionBindings = {
      ...container.bindings,
      workflows: new VolatileWorkflowService(),
    };
    expect(() => validateReadiness(container.config, withInMemoryWorkflow)).toThrow();
  });

  it('allows volatile bindings in the test environment (fakes only)', () => {
    const container = buildContainer(snapshot('development'), { ...ENV });
    expect(() => validateReadiness(container.config, container.bindings)).not.toThrow();
  });

  it('refuses volatile bindings in development by default (fail closed)', () => {
    const container = buildContainer(snapshot('development', { withDatabase: false }), {
      ...ENV_NO_DB,
    });
    expect(() => validateReadiness(container.config, container.bindings)).toThrow();
  });

  it('allows volatile bindings in development behind DEVGUARD_ALLOW_VOLATILE_AUTH=true', () => {
    const container = buildContainer(snapshot('development'), { ...ENV });
    expect(() =>
      validateReadiness(container.config, container.bindings, { allowVolatileDevelopment: true }),
    ).not.toThrow();
  });

  it('ignores the development escape in production (flag cannot weaken prod)', () => {
    const container = buildContainer(snapshot('production', { withDatabase: false }), {
      ...ENV_NO_DB,
    });
    expect(() =>
      validateReadiness(container.config, container.bindings, { allowVolatileDevelopment: true }),
    ).toThrow();
  });

  it('boots durable Postgres bindings in production when DATABASE_URL is configured', () => {
    const container = buildContainer(snapshot('production'), { ...ENV });
    expect(() => validateReadiness(container.config, container.bindings)).not.toThrow();
  });

  it('boots a fully-durable binding set in production', () => {
    const container = buildContainer(snapshot('production'), { ...ENV }, durableOverrides);
    expect(() => validateReadiness(container.config, container.bindings)).not.toThrow();
  });
});

describe('health readiness (CP002 §25: health ready checks DB when pool bound)', () => {
  it('reports the database probe when a pool is bound', async () => {
    const container = buildContainer(snapshot('development'), { ...ENV });
    const api = assembleApi(container);
    const response = await api.app.request('/api/v1/health/ready');
    const body = (await response.json()) as { probes: Array<{ name: string }> };
    expect(body.probes.map((probe) => probe.name)).toContain('database');
  });

  it('omits the database probe when no real DATABASE_URL is configured', async () => {
    const config = loadConfig('api', {
      env: { ...ENV, DEVGUARD_ENV: 'test', DATABASE_URL: '<none>' },
    });
    const container = buildContainer(config, { ...ENV, DATABASE_URL: '<none>' });
    expect(container.pool).toBeUndefined();
    const api = assembleApi(container);
    const response = await api.app.request('/api/v1/health/ready');
    const body = (await response.json()) as { probes: Array<{ name: string }> };
    expect(body.probes.map((probe) => probe.name)).not.toContain('database');
  });
});

describe('volatile marker (CP002 §5)', () => {
  it('detects the volatile workflow and webhook adapters', () => {
    expect(isVolatileBinding(new VolatileWorkflowService())).toBe(true);
    expect(isVolatileBinding(new VolatileWebhookAcceptance())).toBe(true);
  });

  it('does not flag plain durable objects', () => {
    expect(isVolatileBinding(durableOverrides.workflows)).toBe(false);
    expect(isVolatileBinding({})).toBe(false);
    expect(isVolatileBinding(undefined)).toBe(false);
  });
});

describe('architecture: no volatile store defined in app assembly (CP002 §23-8)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('app.ts contains no volatile adapter class and consumes container bindings', () => {
    const source = readFileSync(path.join(repoRoot, 'apps/api/src/app.ts'), 'utf8');
    expect(source).not.toContain('VolatileWorkflowService');
    expect(source).not.toMatch(/class Volatile/);
    expect(source).toContain('container.bindings.workflows');
    expect(source).toContain('container.bindings.webhooks');
  });

  it('the volatile workflow/webhook stores are defined only in volatile-adapters.ts', () => {
    const allSources: Array<[string, string]> = [
      'app.ts',
      'composition/container.ts',
      'composition/volatile-adapters.ts',
      'composition/bindings.ts',
    ].map(
      (file) =>
        [file, readFileSync(path.join(repoRoot, 'apps/api/src', file), 'utf8')] as [string, string],
    );
    const defs = allSources.filter(([, source]) =>
      source.includes('class VolatileWorkflowService'),
    );
    expect(defs.map(([file]) => file)).toEqual(['composition/volatile-adapters.ts']);
    const webhookDefs = allSources.filter(([, source]) =>
      source.includes('class VolatileWebhookAcceptance'),
    );
    expect(webhookDefs.map(([file]) => file)).toEqual(['composition/volatile-adapters.ts']);
  });
});

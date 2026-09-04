/**
 * C002 — Field inventory, classification, and process schemas.
 *
 * Every configuration field declares: owning component, processes that require
 * it, secrecy classification (public | internal | secret), and its default or
 * requiredness. The inventory is the single source for:
 * - unknown-variable detection (fail closed in CI),
 * - `.env.example` parity tests,
 * - public-projection allow-listing.
 */
import { z } from 'zod';
import { isKnownFlagEnvName } from './features.js';

export type ProcessKind = 'api' | 'worker' | 'web';
export const PROCESS_KINDS = ['api', 'worker', 'web'] as const satisfies readonly ProcessKind[];

export type Secrecy = 'public' | 'internal' | 'secret';

export interface FieldDefinition {
  readonly name: string;
  readonly owner: string;
  readonly processes: readonly ProcessKind[];
  readonly secrecy: Secrecy;
  /** Placeholder value written to .env.example (names only, never secrets). */
  readonly example?: string;
  readonly description: string;
}

function field(
  name: string,
  owner: string,
  processes: ProcessKind[],
  secrecy: Secrecy,
  description: string,
  example?: string,
): FieldDefinition {
  return {
    name,
    owner,
    processes,
    secrecy,
    description,
    ...(example !== undefined ? { example } : {}),
  };
}

/**
 * Canonical environment variable inventory.
 *
 * Namespace contract:
 * - `DEVGUARD_*` — server settings
 * - `FLAG_*`     — feature-flag overrides (strict booleans)
 * - `PUBLIC_*`   — values explicitly allowed to reach the browser
 * - well-known provider variable names (DATABASE_URL, REDIS_URL, GITHUB_*,
 *   TRUEFORGE_*, AUTH_*, S3_*) are registered individually below.
 */
export const FIELD_INVENTORY: readonly FieldDefinition[] = Object.freeze([
  field(
    'DEVGUARD_ENV',
    'C002',
    ['api', 'worker', 'web'],
    'internal',
    'Deployment environment.',
    'development',
  ),
  field(
    'DATABASE_URL',
    'C007',
    ['api', 'worker'],
    'secret',
    'PostgreSQL connection secret reference.',
  ),
  field('REDIS_URL', 'C057', ['api', 'worker'], 'secret', 'Redis connection secret reference.'),
  field(
    'AUTH_MODE',
    'C005',
    ['api'],
    'internal',
    'Authentication mode: github_oauth or none (dev/test only).',
    'github_oauth',
  ),
  field('AUTH_SESSION_SECRET', 'C005', ['api'], 'secret', 'Session signing secret reference.'),
  field('AUTH_GITHUB_OAUTH_CLIENT_ID', 'C005', ['api'], 'internal', 'GitHub OAuth client id.'),
  field(
    'AUTH_GITHUB_OAUTH_CLIENT_SECRET',
    'C005',
    ['api'],
    'secret',
    'GitHub OAuth client secret reference.',
  ),
  field('AUTH_GITHUB_OAUTH_CALLBACK_URL', 'C005', ['api'], 'internal', 'OAuth callback URL.'),
  field('DEVGUARD_GITHUB_APP_ID', 'C017', ['api', 'worker'], 'internal', 'GitHub App numeric id.'),
  field('DEVGUARD_GITHUB_APP_SLUG', 'C017', ['api', 'worker'], 'internal', 'GitHub App URL slug.'),
  field(
    'GITHUB_APP_PRIVATE_KEY',
    'C017',
    ['api', 'worker'],
    'secret',
    'GitHub App private key reference.',
  ),
  field(
    'GITHUB_WEBHOOK_SECRET',
    'C022',
    ['api'],
    'secret',
    'GitHub webhook signing secret reference.',
  ),
  field(
    'DEVGUARD_GITHUB_API_BASE_URL',
    'C018',
    ['api', 'worker'],
    'internal',
    'GitHub API base URL override.',
    'https://api.github.com',
  ),
  field(
    'DEVGUARD_TRUEFORGE_BASE_URL',
    'C036',
    ['api', 'worker'],
    'internal',
    'TrueForge server base URL.',
  ),
  field(
    'TRUEFORGE_API_KEY',
    'C036',
    ['api', 'worker'],
    'secret',
    'TrueForge service credential reference.',
  ),
  field(
    'DEVGUARD_TRUEFORGE_TIMEOUT_MS',
    'C036',
    ['api', 'worker'],
    'internal',
    'TrueForge call timeout in milliseconds.',
    '30000',
  ),
  field(
    'DEVGUARD_ARTIFACT_DRIVER',
    'C012',
    ['api', 'worker'],
    'internal',
    'Artifact store driver: local or s3.',
    'local',
  ),
  field(
    'DEVGUARD_ARTIFACT_LOCAL_DIR',
    'C012',
    ['api', 'worker'],
    'internal',
    'Local artifact directory (dev/test).',
    '.data/artifacts',
  ),
  field(
    'DEVGUARD_S3_ENDPOINT',
    'C012',
    ['api', 'worker'],
    'internal',
    'S3-compatible endpoint URL.',
  ),
  field('DEVGUARD_S3_BUCKET', 'C012', ['api', 'worker'], 'internal', 'S3 bucket name.'),
  field(
    'S3_ACCESS_KEY_ID',
    'C012',
    ['api', 'worker'],
    'secret',
    'Object storage access key reference.',
  ),
  field(
    'S3_SECRET_ACCESS_KEY',
    'C012',
    ['api', 'worker'],
    'secret',
    'Object storage secret key reference.',
  ),
  field(
    'DEVGUARD_RETENTION_AUDIT_DAYS',
    'C064',
    ['api', 'worker'],
    'internal',
    'Audit record retention in days.',
    '365',
  ),
  field(
    'DEVGUARD_RETENTION_WORKFLOW_EVENT_DAYS',
    'C063',
    ['api', 'worker'],
    'internal',
    'Workflow event retention in days.',
    '90',
  ),
  field(
    'DEVGUARD_RETENTION_ARTIFACT_DAYS',
    'C012',
    ['api', 'worker'],
    'internal',
    'Artifact retention in days.',
    '30',
  ),
  field(
    'DEVGUARD_RETENTION_TRANSCRIPT_DAYS',
    'C011',
    ['api', 'worker'],
    'internal',
    'Runtime transcript retention in days.',
    '30',
  ),
  field(
    'DEVGUARD_WEBHOOK_MAX_BODY_BYTES',
    'C094',
    ['api'],
    'internal',
    'Maximum accepted webhook body size.',
    '1048576',
  ),
  field(
    'DEVGUARD_MAX_ACTIVE_RUNS_PER_REPOSITORY',
    'C047',
    ['api', 'worker'],
    'internal',
    'Concurrent workflow run cap per repository.',
    '3',
  ),
  field(
    'DEVGUARD_LOG_LEVEL',
    'C061',
    ['api', 'worker'],
    'internal',
    'Log level: debug, info, warn, error.',
    'info',
  ),
  field(
    'DEVGUARD_TRUSTED_PROXY_ENABLED',
    'C094',
    ['api'],
    'internal',
    'Trust X-Forwarded-For from the reverse proxy.',
    'false',
  ),
  field(
    'DEVGUARD_PUBLIC_ORIGIN',
    'C005',
    ['api'],
    'internal',
    'Browser-facing DevGuard origin for CSRF/origin checks.',
    'http://localhost:3000',
  ),
  field(
    'DEVGUARD_SESSION_IDLE_MINUTES',
    'C005',
    ['api'],
    'internal',
    'Idle session expiry in minutes.',
    '60',
  ),
  field(
    'DEVGUARD_SESSION_ABSOLUTE_HOURS',
    'C005',
    ['api'],
    'internal',
    'Absolute session lifetime in hours.',
    '24',
  ),
  field(
    'PUBLIC_API_BASE_URL',
    'C076',
    ['web'],
    'public',
    'Browser-facing API base URL.',
    'http://localhost:4000',
  ),
  field(
    'DEVGUARD_API_ORIGIN',
    'C076',
    ['web'],
    'internal',
    'Upstream API origin for Next.js /api/v1 rewrites.',
    'http://127.0.0.1:4000',
  ),
]);

const INVENTORY_BY_NAME = new Map(FIELD_INVENTORY.map((f) => [f.name, f]));

export function getFieldDefinition(name: string): FieldDefinition | undefined {
  return INVENTORY_BY_NAME.get(name);
}

/** Variables owned by this codebase; anything else matching the namespace is flagged. */
const OWNED_NAMESPACE_PATTERNS: readonly RegExp[] = [
  /^DEVGUARD_/,
  /^FLAG_[A-Z]+(_[A-Z]+)*$/,
  /^PUBLIC_[A-Z]+(_[A-Z]+)*$/,
];

export function isOwnedNamespace(name: string): boolean {
  return OWNED_NAMESPACE_PATTERNS.some((pattern) => pattern.test(name));
}

export interface EnvScanResult {
  readonly unknown: readonly string[];
}

/** Detect unknown variables within DevGuard namespaces. */
export function scanForUnknownVariables(
  env: Readonly<Record<string, string | undefined>>,
): EnvScanResult {
  const unknown: string[] = [];
  for (const name of Object.keys(env)) {
    // Any name whose prefix looks like a flag (case-insensitively) must be in
    // the closed typed registry, regardless of casing or characters. This runs
    // BEFORE the owned-namespace patterns so malformed flags
    // (FLAG_githubWritesEnabled, FLAG_FEATURE_1, flag_webhook_ingress_enabled,
    // FLAG_, double underscores) can never slip through unvalidated.
    if (name.toUpperCase().startsWith('FLAG_')) {
      if (!isKnownFlagEnvName(name)) unknown.push(name);
      continue;
    }
    if (!isOwnedNamespace(name)) continue;
    if (!INVENTORY_BY_NAME.has(name)) {
      unknown.push(name);
    }
  }
  return { unknown };
}

// ---------------------------------------------------------------------------
// Parsing helpers: every raw string is validated; issues never embed values.
// ---------------------------------------------------------------------------

export class ConfigurationIssuesError extends Error {
  readonly issues: ReadonlyArray<{ path: string; constraint: string }>;
  constructor(issues: ReadonlyArray<{ path: string; constraint: string }>) {
    super(`Configuration invalid (${issues.length} issue(s)).`);
    this.name = 'ConfigurationIssuesError';
    this.issues = issues;
  }
}

export class ConfigParser {
  private readonly issues: Array<{ path: string; constraint: string }> = [];

  addIssue(path: string, constraint: string): void {
    this.issues.push({ path, constraint });
  }

  addIssues(issues: ReadonlyArray<{ path: string; constraint: string }>): void {
    this.issues.push(...issues);
  }

  hasIssueFor(path: string): boolean {
    return this.issues.some((issue) => issue.path === path);
  }

  get hasIssues(): boolean {
    return this.issues.length > 0;
  }

  get issuesList(): ReadonlyArray<{ path: string; constraint: string }> {
    return this.issues;
  }

  optionalString(
    env: Readonly<Record<string, string | undefined>>,
    name: string,
  ): string | undefined {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    return raw;
  }

  enum<T extends readonly string[]>(
    env: Readonly<Record<string, string | undefined>>,
    name: string,
    allowed: T,
    fallback: T[number],
  ): T[number] {
    const raw = this.optionalString(env, name);
    if (raw === undefined) return fallback;
    if (!(allowed as readonly string[]).includes(raw)) {
      this.addIssue(name, `must be one of: ${allowed.join('|')}`);
      return fallback;
    }
    return raw;
  }

  intInRange(
    env: Readonly<Record<string, string | undefined>>,
    name: string,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const raw = this.optionalString(env, name);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== raw.trim()) {
      this.addIssue(name, 'must be a base-10 integer');
      return fallback;
    }
    if (parsed < min || parsed > max) {
      this.addIssue(name, `must be between ${min} and ${max}`);
      return fallback;
    }
    return parsed;
  }

  url(
    env: Readonly<Record<string, string | undefined>>,
    name: string,
    protocols: readonly string[],
  ): string | undefined {
    const raw = this.optionalString(env, name);
    if (raw === undefined) return undefined;
    try {
      const parsedUrl = new URL(raw);
      if (!protocols.includes(parsedUrl.protocol)) {
        this.addIssue(name, `URL protocol must be one of: ${protocols.join(', ')}`);
        return undefined;
      }
      return parsedUrl.toString();
    } catch {
      this.addIssue(name, 'must be a valid absolute URL');
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Section schemas
// ---------------------------------------------------------------------------

const ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface RetentionConfig {
  readonly auditDays: number;
  readonly workflowEventDays: number;
  readonly artifactDays: number;
  readonly transcriptDays: number;
}

export interface LimitsConfig {
  readonly webhookMaxBodyBytes: number;
  readonly maxActiveRunsPerRepository: number;
}

export interface ObservabilityConfig {
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface GithubAppConfig {
  readonly appId: string;
  readonly appSlug?: string | undefined;
  readonly privateKeyRef: string;
  readonly webhookSecretRef: string;
  readonly apiBaseUrl: string;
}

export interface TrueForgeConfig {
  readonly baseUrl: string;
  /** Omitted when the TrueForge instance has no API-key auth (OSS default). */
  readonly apiKeyRef?: string | undefined;
  readonly timeoutMs: number;
}

export interface SessionPolicy {
  readonly idleMinutes: number;
  readonly absoluteHours: number;
}

export function parseSessionPolicy(parser: ConfigParser, env: EnvRecord): SessionPolicy {
  return {
    idleMinutes: parser.intInRange(env, 'DEVGUARD_SESSION_IDLE_MINUTES', 5, 10_080, 60),
    absoluteHours: parser.intInRange(env, 'DEVGUARD_SESSION_ABSOLUTE_HOURS', 1, 720, 24),
  };
}

export function parsePublicOrigin(parser: ConfigParser, env: EnvRecord): string | undefined {
  return parser.url(env, 'DEVGUARD_PUBLIC_ORIGIN', ['https:', 'http:']);
}

export function parseTrustedProxy(parser: ConfigParser, env: EnvRecord): boolean {
  const raw = parser.optionalString(env, 'DEVGUARD_TRUSTED_PROXY_ENABLED');
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  parser.addIssue('DEVGUARD_TRUSTED_PROXY_ENABLED', 'must be exactly "true" or "false"');
  return false;
}

export interface ArtifactStorageConfig {
  readonly driver: 'local' | 's3';
  readonly localDir?: string;
  readonly s3?: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyIdRef: string;
    readonly secretAccessKeyRef: string;
  };
}

export type AuthConfig =
  | {
      readonly mode: 'github_oauth';
      readonly sessionSecretRef: string;
      readonly oauthClientId: string;
      readonly oauthClientSecretRef: string;
      readonly oauthCallbackUrl: string;
    }
  | { readonly mode: 'none'; readonly devOnlyReason: 'development_or_test' };

function parseGithubApp(parser: ConfigParser, env: EnvRecord): GithubAppConfig | undefined {
  const appId = parser.optionalString(env, 'DEVGUARD_GITHUB_APP_ID');
  const appSlug = parser.optionalString(env, 'DEVGUARD_GITHUB_APP_SLUG');
  const privateKeyRef = parser.optionalString(env, 'GITHUB_APP_PRIVATE_KEY');
  const webhookSecretRef = parser.optionalString(env, 'GITHUB_WEBHOOK_SECRET');
  const apiBaseUrl =
    parser.url(env, 'DEVGUARD_GITHUB_API_BASE_URL', ['https:']) ?? 'https://api.github.com/';
  // Partial presence is an error: credentials are configured as a unit.
  const provided = [appId, privateKeyRef, webhookSecretRef].filter((v) => v !== undefined).length;
  if (provided === 0) return undefined;
  if (
    provided < 3 ||
    appId === undefined ||
    privateKeyRef === undefined ||
    webhookSecretRef === undefined
  ) {
    parser.addIssue(
      'DEVGUARD_GITHUB_APP_ID',
      'GitHub App requires app id, private key ref and webhook secret ref together',
    );
    return undefined;
  }
  if (!/^\d+$/.test(appId)) {
    parser.addIssue('DEVGUARD_GITHUB_APP_ID', 'must be a numeric GitHub App id');
  }
  return { appId, appSlug, privateKeyRef, webhookSecretRef, apiBaseUrl };
}

function parseTrueForge(parser: ConfigParser, env: EnvRecord): TrueForgeConfig | undefined {
  const baseUrl = parser.url(env, 'DEVGUARD_TRUEFORGE_BASE_URL', ['https:', 'http:']);
  const apiKeyRef = parser.optionalString(env, 'TRUEFORGE_API_KEY');
  const timeoutMs = parser.intInRange(env, 'DEVGUARD_TRUEFORGE_TIMEOUT_MS', 1_000, 120_000, 30_000);
  const integrationRequested = env['FLAG_TRUEFORGE_INTEGRATION_ENABLED'] === 'true';
  if (baseUrl === undefined) {
    if (integrationRequested || apiKeyRef !== undefined) {
      parser.addIssue(
        'DEVGUARD_TRUEFORGE_BASE_URL',
        'required when TrueForge integration is enabled',
      );
    }
    return undefined;
  }
  return {
    baseUrl,
    timeoutMs,
    ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
  };
}

function parseArtifactStorage(parser: ConfigParser, env: EnvRecord): ArtifactStorageConfig {
  const driver = parser.enum(env, 'DEVGUARD_ARTIFACT_DRIVER', ['local', 's3'] as const, 'local');
  if (driver === 's3') {
    const endpoint = parser.url(env, 'DEVGUARD_S3_ENDPOINT', ['https:']);
    const bucket = parser.optionalString(env, 'DEVGUARD_S3_BUCKET');
    const accessKeyIdRef = parser.optionalString(env, 'S3_ACCESS_KEY_ID');
    const secretAccessKeyRef = parser.optionalString(env, 'S3_SECRET_ACCESS_KEY');
    if (
      endpoint === undefined ||
      bucket === undefined ||
      accessKeyIdRef === undefined ||
      secretAccessKeyRef === undefined
    ) {
      parser.addIssue(
        'DEVGUARD_S3_BUCKET',
        's3 driver requires endpoint, bucket, and both key references',
      );
      return { driver: 'local', localDir: '.data/artifacts' };
    }
    return {
      driver: 's3',
      s3: { endpoint, bucket, accessKeyIdRef, secretAccessKeyRef },
    };
  }
  if (env['DEVGUARD_ENV'] === 'production') {
    parser.addIssue(
      'DEVGUARD_ARTIFACT_DRIVER',
      'local artifact storage is forbidden in production; configure the s3 driver',
    );
  }
  return {
    driver: 'local',
    localDir: parser.optionalString(env, 'DEVGUARD_ARTIFACT_LOCAL_DIR') ?? '.data/artifacts',
  };
}

export function parseAuth(
  parser: ConfigParser,
  env: EnvRecord,
  environment: Environment,
): AuthConfig {
  const mode = parser.enum(env, 'AUTH_MODE', ['github_oauth', 'none'] as const, 'github_oauth');
  if (mode === 'none') {
    if (environment === 'production') {
      parser.addIssue('AUTH_MODE', 'auth mode "none" is forbidden in production');
    }
    return { mode: 'none', devOnlyReason: 'development_or_test' };
  }
  // Secret fields carry NAMES (references), never values. Presence of a
  // non-empty value under the well-known variable name is what we verify.
  const sessionSecretValue = parser.optionalString(env, 'AUTH_SESSION_SECRET');
  const oauthClientId = parser.optionalString(env, 'AUTH_GITHUB_OAUTH_CLIENT_ID');
  const oauthClientSecretValue = parser.optionalString(env, 'AUTH_GITHUB_OAUTH_CLIENT_SECRET');
  const callbackUrl = parser.url(env, 'AUTH_GITHUB_OAUTH_CALLBACK_URL', ['https:', 'http:']);
  const sessionSecretRef = sessionSecretValue !== undefined ? 'AUTH_SESSION_SECRET' : undefined;
  const oauthClientSecretRef =
    oauthClientSecretValue !== undefined ? 'AUTH_GITHUB_OAUTH_CLIENT_SECRET' : undefined;
  if (
    sessionSecretRef === undefined ||
    oauthClientId === undefined ||
    oauthClientSecretRef === undefined ||
    callbackUrl === undefined
  ) {
    const missing: string[] = [];
    if (sessionSecretRef === undefined) missing.push('AUTH_SESSION_SECRET');
    if (oauthClientId === undefined) missing.push('AUTH_GITHUB_OAUTH_CLIENT_ID');
    if (oauthClientSecretRef === undefined) missing.push('AUTH_GITHUB_OAUTH_CLIENT_SECRET');
    if (callbackUrl === undefined) missing.push('AUTH_GITHUB_OAUTH_CALLBACK_URL');
    for (const name of missing) {
      parser.addIssue(name, 'required when AUTH_MODE=github_oauth');
    }
    // Fail closed placeholder keeps the union honest; loader throws before use.
    return { mode: 'none', devOnlyReason: 'development_or_test' };
  }
  return {
    mode: 'github_oauth',
    sessionSecretRef,
    oauthClientId,
    oauthClientSecretRef,
    oauthCallbackUrl: callbackUrl,
  };
}

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface ParsedServerSections {
  readonly databaseUrlRef: string;
  readonly redisUrlRef: string;
  readonly retention: RetentionConfig;
  readonly limits: LimitsConfig;
  readonly observability: ObservabilityConfig;
  readonly github?: GithubAppConfig;
  readonly trueforge?: TrueForgeConfig;
  readonly artifacts: ArtifactStorageConfig;
}

/** Sections shared by api/worker. Required refs must be present or issues accrue. */
export function parseServerSections(parser: ConfigParser, env: EnvRecord): ParsedServerSections {
  const databaseUrlRef = parser.optionalString(env, 'DATABASE_URL');
  if (databaseUrlRef === undefined) {
    parser.addIssue('DATABASE_URL', 'required for api/worker processes');
  }
  const redisUrlRef = parser.optionalString(env, 'REDIS_URL');
  if (redisUrlRef === undefined) {
    parser.addIssue('REDIS_URL', 'required for api/worker processes');
  }
  const github = parseGithubApp(parser, env);
  const trueforge = parseTrueForge(parser, env);
  return {
    databaseUrlRef: databaseUrlRef ?? '<missing>',
    redisUrlRef: redisUrlRef ?? '<missing>',
    retention: {
      auditDays: parser.intInRange(env, 'DEVGUARD_RETENTION_AUDIT_DAYS', 1, 3650, 365),
      workflowEventDays: parser.intInRange(
        env,
        'DEVGUARD_RETENTION_WORKFLOW_EVENT_DAYS',
        1,
        3650,
        90,
      ),
      artifactDays: parser.intInRange(env, 'DEVGUARD_RETENTION_ARTIFACT_DAYS', 1, 3650, 30),
      transcriptDays: parser.intInRange(env, 'DEVGUARD_RETENTION_TRANSCRIPT_DAYS', 1, 3650, 30),
    },
    limits: {
      webhookMaxBodyBytes: parser.intInRange(
        env,
        'DEVGUARD_WEBHOOK_MAX_BODY_BYTES',
        65_536,
        16_777_216,
        1_048_576,
      ),
      maxActiveRunsPerRepository: parser.intInRange(
        env,
        'DEVGUARD_MAX_ACTIVE_RUNS_PER_REPOSITORY',
        1,
        10,
        3,
      ),
    },
    observability: {
      logLevel: parser.enum(
        env,
        'DEVGUARD_LOG_LEVEL',
        ['debug', 'info', 'warn', 'error'] as const,
        'info',
      ) as ObservabilityConfig['logLevel'],
    },
    ...(github !== undefined ? { github } : {}),
    ...(trueforge !== undefined ? { trueforge } : {}),
    artifacts: parseArtifactStorage(parser, env),
  };
}

export function parseEnvironment(parser: ConfigParser, env: EnvRecord): Environment {
  const raw = parser.optionalString(env, 'DEVGUARD_ENV');
  if (raw === undefined) {
    parser.addIssue('DEVGUARD_ENV', 'required (development|test|production)');
    return 'production';
  }
  return parser.enum(env, 'DEVGUARD_ENV', ENVIRONMENTS, 'production');
}

export function parseWebApiBaseUrl(parser: ConfigParser, env: EnvRecord): string | undefined {
  return parser.url(env, 'PUBLIC_API_BASE_URL', ['https:', 'http:']);
}

/** Zod schema retained for boundary validation of externally supplied snapshots. */
export const safeSummaryIssueSchema = z.object({
  path: z.string().min(1),
  constraint: z.string().min(1),
});

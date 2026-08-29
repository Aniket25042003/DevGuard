/**
 * @devguard/db — PostgreSQL foundation (C007) and reliability primitives (C008).
 *
 * Boundary rule: `pg` is imported only inside this package. Domain/application
 * code consumes the ports exported here; SQL never leaves the persistence layer.
 */
export type { DatabaseHealthStatus, DbPoolConfig, DevGuardPool } from './pool.js';
export { createPool } from './pool.js';

export type {
  IsolationLevel,
  TransactionContext,
  TransactionOptions,
  UnitOfWork,
} from './transaction.js';
export { createUnitOfWork } from './transaction.js';

export type { RetryDecision, SqlStatement } from './sql.js';
export { classifySqlState, sqlStateOf } from './sql.js';

export { uuidv7 } from './uuid.js';

export type {
  AppliedMigrationRow,
  MigrationPlan,
  MigrationSource,
  ParsedMigration,
} from './migrations/list.js';
export {
  loadMigrationSources,
  parseMigrations,
  planMigrations,
  resolveMigrationsDir,
  sha256Hex,
} from './migrations/list.js';

export type { MigrationRunOptions, MigrationRunResult } from './migrations/runner.js';
export { runMigrations } from './migrations/runner.js';

export { assertSchemaCompatible } from './schema.js';

export type { BeginInput, BeginOutcome, StoredResult } from './reliability/idempotency.js';
export {
  canonicalJsonStringify,
  IdempotencyStore,
  idempotencyKeyHash,
  requestFingerprint,
} from './reliability/idempotency.js';

export type { OutboxEventLike, OutboxRecord } from './reliability/outbox.js';
export {
  MAX_OUTBOX_ATTEMPTS,
  MAX_OUTBOX_SERIALIZED_BYTES,
  OutboxRepository,
  OutboxWriter,
} from './reliability/outbox.js';

// ---- C009 identity/repository persistence ----
export {
  ConnectedRepositoryStore,
  IdentityRepository,
  InstallationStore,
} from './repositories/identity-repository.js';
export type {
  ConnectedRepository,
  ConnectRepositoryInput,
  InstallationSnapshot,
  ObservedIdentityInput,
  RepositoryLifecycleStatus,
  RepositoryPatch,
  UserIdentity,
} from './repositories/identity-repository.js';

// ---- C010 policy/approval persistence ----
export { ApprovalStore, PolicyVersionStore } from './repositories/policy-approval.js';
export type { ApprovalStatusTransition, CanonicalPolicy } from './repositories/policy-approval.js';

// ---- C011 workflow/evidence persistence ----
export { WorkflowRunStore, EventStore } from './repositories/workflow-evidence.js';
export type {
  NewRunInput,
  StoredEvent,
  WorkflowRunProjection,
  WorkflowRunRecord,
} from './repositories/workflow-evidence.js';

// ---- C012 retention/storage ----
export { RetentionResolver, StorageOperationRepository } from './repositories/retention.js';
export type { RetentionDecision, RetentionPolicyInput } from './repositories/retention.js';

// ---- CP003 durable auth sessions/transactions/identity ----
export {
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  PostgresUserIdentityLinker,
} from './repositories/auth-sessions.js';
export type {
  AuthSessionRecord,
  AuthTransactionRecord,
  IdentityProfileInput,
} from './repositories/auth-sessions.js';
export { mapAuthSessionRow, mapAuthTransactionRow } from './repositories/auth-sessions.js';

// ---- CP005 repository local-access port ----
export { PostgresLocalRepositoryAccessPort } from './repositories/local-access.js';
export type { LocalLinkageStatus, LocalRepositoryLinkage } from './repositories/local-access.js';

// ---- CP004 CLI/API bearer tokens ----
export { PostgresApiTokenRepository } from './repositories/api-tokens.js';
export type { ApiTokenRecord } from './repositories/api-tokens.js';
export { mapApiTokenRow } from './repositories/api-tokens.js';

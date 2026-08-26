# ADR-0012: PostgreSQL tooling — pg + thin own wrapper

- Status: Accepted (2026-09-18)
- Component: C007/C008
- Context: C007 §28 left three decisions blocking implementation: the database library/migration stack, where UUIDv7 identifiers are generated, and the supported Postgres baseline. DevGuard requires explicit SQL migrations, least-privilege roles, parameterized queries only, and provider types that terminate at adapters.

## Decision

1. **Driver: `pg`, no ORM/Kysely/Drizzle.** All SQL is hand-written and
   parameterized (`$1` style) behind a thin wrapper in `packages/db`
   (`DevGuardPool`, `UnitOfWork`). An ORM's auto-mutation or query-generation
   features would bypass the migration discipline and boundary rules C007 §27
   warns about; DevGuard's query surface is small and aggregate-focused.
2. **Migrations: numbered `NNN_name.sql` files + own runner.** The runner in
   `packages/db/src/migrations` takes `pg_advisory_lock(hashtext('devguard_migrations'))`,
   applies pending files in version order each in its own transaction, records a
   sha256 checksum of file content in `schema_migrations`, refuses changed
   checksums on applied files, and releases the lock. No external migration tool.
3. **UUIDv7 generated application-side** via a helper in `packages/db` using
   `node:crypto` (RFC 9562): time-ordered keys without database-side
   dependencies; IDs exist before insert for batch/outbox flows.
4. **PostgreSQL 16 baseline.** Session defaults (`statement_timeout`),
   transactional DDL, `FOR UPDATE SKIP LOCKED`, and `gen_random_uuid`-free
   conventions all target PG16 behavior; older majors are unsupported.

## Consequences

- `pg` is imported only within `packages/db`; row types never cross the
  persistence boundary.
- Schema changes ship exclusively as new immutable migrations; applied files
  are checksum-frozen and dirty states block startup via
  `assertSchemaCompatible`.
- The runner owns lock/checksum/dirty-state semantics that tools like
  node-pg-migrate would otherwise provide implicitly — covered by unit tests
  (planning core) and DB-gated integration tests (concurrency, rollback).

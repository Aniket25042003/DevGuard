# ADR-0010: Early security controls — trust boundaries and secrets handling

- Status: Accepted (2026-08-25)
- Components: C092 (trust/prompt-injection), C093 (secrets/redaction)
- Context: Both plans defer several decisions ("Open Decisions") and depend on later components (C016/C024–C030/C036–C044/C061). Per the dependency graph's Band A guidance this PR ships the early libraries with fakes/tests while provider integrations stay behind ports.

## Decisions

### C092 — trust boundary

1. **Detector approach:** deterministic rule set only for MVP (`InjectionSignalScanner`). Signals are evidence; they can force quarantine/review but never authorize or downgrade policy. An advisory classifier may plug in later behind the same return shape without touching call sites.
2. **Content references:** context items are referenced by SHA-256 content digest plus provenance id; large/hostile payloads remain with their source system. Durable retention belongs to C012/C064.
3. **Quarantine release:** no operator release path in MVP. Quarantined items are terminal for the run; re-fetching corrected content creates a NEW provenance item (idempotency key includes the digest).
4. **System/context role separation:** enforced here via labeled sections + boundary encoding; verified TrueForge role semantics remain a C036 preflight gate before mutating workflows enable.

### C093 — secrets

1. **Backend for MVP:** process environment via `EnvironmentSecretProvider`-compatible adapter behind the `SecretBackend` port. KMS/secret-manager adapters land with deployment wiring (C100) without changing call sites.
2. **Encrypted application-managed secrets:** not required for MVP functionality; the AEAD primitive (`EnvelopeEncryptor`, AES-256-GCM, versioned keys, scope-bound associated data) is provided now so any unavoidable persistence later is encrypted by construction.
3. **Scanner:** deterministic detectors only (token formats, PEM/JWT/DSN/assigned-secret patterns + exact-value registry). Allowlists cannot suppress exact registered-secret matches. A mature scanning engine may replace the internals behind `PublicationGuard` later.
4. **Incident automation:** exposure evidence blocks publication/execution immediately; provider rotation is operator-invoked in MVP (runbook documented at deployment time), with rotation-required events emitted.

## Consequences

- All later components consume these utilities instead of inventing parallel redaction/scanning/trust logic (no-touch zone from merge onward).
- The synthetic-canary leak suite added here becomes the CI gate that C097 extends end-to-end.

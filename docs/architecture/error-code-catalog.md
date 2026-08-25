# Error Code Catalog

Stable, provider-neutral error codes (C003). Codes are **never repurposed or
removed**; deprecated codes are marked as such but remain registered so
historical persisted records stay interpretable. The registry in
`packages/errors/src/codes.ts` is authoritative; a test asserts this table
lists exactly the registered codes.

| Code                          | Category      | HTTP | Retry class          | Safe message                                                        | Details schema                    |
| ----------------------------- | ------------- | ---- | -------------------- | ------------------------------------------------------------------- | --------------------------------- |
| CONFIGURATION_INVALID         | configuration | 500  | no_retry             | Service configuration is invalid.                                   | issues[{path, constraint}]        |
| DEPENDENCY_UNAVAILABLE        | integration   | 503  | reconcile_then_retry | A required service is temporarily unavailable.                      | —                                 |
| IDEMPOTENCY_KEY_CONFLICT      | concurrency   | 409  | no_retry             | This operation key was already used with different content.         | —                                 |
| CONTENT_QUARANTINED           | domain        | 403  | no_retry             | This content was quarantined and cannot be used.                    | {reasonCode}                      |
| PROVENANCE_INVALID            | validation    | 400  | no_retry             | Content provenance could not be verified.                           | {field}                           |
| PUBLICATION_BLOCKED           | security      | 422  | no_retry             | Publication was blocked by the leak-scan guard.                     | {reasonCode, findingCount}        |
| SECRET_ACCESS_DENIED          | authorization | 403  | no_retry             | Access to this secret is not permitted for the caller.              | —                                 |
| SECRET_STATE_INVALID          | domain        | 409  | no_retry             | The secret reference is not in a resolvable state.                  | {status, expectedStatus?}         |
| SECRET_UNAVAILABLE            | integration   | 503  | safe_retry           | The requested secret is unavailable or expired.                     | —                                 |
| TRUST_ITEM_INVALID_TRANSITION | domain        | 409  | no_retry             | Trust evaluation state transition is not allowed.                   | {from, to}                        |
| UNTRUSTED_PROPOSAL_REJECTED   | authorization | 403  | no_retry             | The proposal carried untrusted authorization data and was rejected. | {strippedFields}                  |
| INTERNAL                      | application   | 500  | human_intervention   | An unexpected error occurred.                                       | —                                 |
| NOT_FOUND                     | application   | 404  | no_retry             | The requested resource was not found.                               | —                                 |
| PROVIDER_RATE_LIMITED         | integration   | 429  | safe_retry           | The external provider rate limit was reached.                       | —                                 |
| PROVIDER_UNAVAILABLE          | integration   | 503  | reconcile_then_retry | The external provider is temporarily unavailable.                   | —                                 |
| RATE_LIMITED                  | application   | 429  | safe_retry           | Too many requests. Slow down and retry shortly.                     | —                                 |
| REPOSITORY_FORBIDDEN          | authorization | 403  | no_retry             | You do not have access to this repository.                          | —                                 |
| UNAUTHENTICATED               | authorization | 401  | no_retry             | Authentication is required.                                         | —                                 |
| VALIDATION_FAILED             | validation    | 400  | no_retry             | The submitted input failed validation.                              | issues[{path, constraint}]        |
| VERSION_CONFLICT              | concurrency   | 409  | no_retry             | The resource changed concurrently; reload and try again.            | {expectedVersion, currentVersion} |

## Evolution policy

1. Adding a code: extend the registry via `registerError` **and** add a row
   here in the same PR; the catalog-sync test enforces both directions.
2. Changing a descriptor's category/status/retry class/message after release is
   a breaking contract change requiring a dedicated reviewed PR.
3. Domain-specific codes (policy denial, approval staleness, webhook rejection,
   …) are registered by their owning components, not pre-registered here.

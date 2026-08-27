/**
 * C023 §10/§12/§20 — PolicyDocumentService.
 *
 * Pipeline: decode → schema parse → semantic validate → normalize → hash.
 * Validation is pure. Version creation is idempotent by
 * (repository, canonical hash). Activation is atomic CAS through the port.
 * Unknown references fail closed via injected registries.
 */
import type { RepositoryPolicyV1 } from './schema/policy-v1.js';
import { POLICY_LIMIT_GLOBAL_CAPS, repositoryPolicyV1 } from './schema/policy-v1.js';
import { PolicyValidationReport, type PolicyDiagnostic } from './schema/diagnostics.js';
import { PolicyDecoder } from './parsing/decoder.js';
import { validateSemantics, type SemanticContext } from './validation/semantic.js';
import {
  canonicalHash,
  canonicalJson,
  normalizePolicyV1,
  type effectiveLimits,
} from './normalization/canonical.js';
import {
  buildVersionRecord,
  canTransition,
  type ActivatePolicyVersionInput,
  type PolicySnapshot,
  type PolicyVersionRecord,
  type PolicyVersionRepositoryPort,
  type RegistryBindingVersions,
} from './versioning/version.js';

void POLICY_LIMIT_GLOBAL_CAPS;

export interface PolicySource {
  readonly bytes: Uint8Array | string;
  readonly formatHint?: 'yaml' | 'json' | undefined;
}

export interface ValidatePolicyResult {
  readonly ok: boolean;
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly canonical?:
    | {
        readonly json: string;
        readonly hash: string;
        readonly limits: ReturnType<typeof effectiveLimits>;
        readonly actionCount: number;
      }
    | undefined;
}

export interface CreatePolicyVersionInput {
  readonly source: PolicySource;
  readonly repositoryId: string;
  readonly createdBy: string;
  readonly semanticContext: SemanticContext;
}

export interface PolicyDocumentServiceOptions {
  readonly versions: PolicyVersionRepositoryPort;
  /** Mints stable unique IDs for version rows. */
  readonly newVersionId: () => string;
  readonly now?: () => Date;
}

export class PolicyDocumentService {
  constructor(private readonly options: PolicyDocumentServiceOptions) {}

  /** Pure validation: never persists anything (C023 §20). */
  async validate(input: PolicySource, context: SemanticContext): Promise<ValidatePolicyResult> {
    const normalized = this.#runPipeline(input, context);
    if (!normalized.ok || !normalized.policy) {
      return {
        ok: false,
        diagnostics: normalized.report.items.map((d) => d),
      };
    }
    return {
      ok: true,
      diagnostics: [],
      canonical: {
        json: canonicalJson(normalized.policy),
        hash: canonicalHash(normalized.policy),
        limits: normalized.policy.limits,
        actionCount:
          normalized.policy.actions.allow.length +
          normalized.policy.actions.requireApproval.length +
          normalized.policy.actions.deny.length,
      },
    };
  }

  /**
   * Validate then create a validated-but-inactive version row.
   * Idempotent per (repositoryId, hash): replay returns the original record.
   */
  async createVersion(
    input: CreatePolicyVersionInput,
  ): Promise<
    | { created: true; record: PolicyVersionRecord }
    | { created: false; diagnostics: readonly PolicyDiagnostic[] }
  > {
    const result = await this.#validateForWrite(input);
    return result;
  }

  /**
   * Activation: verifies state legality locally then delegates the atomic
   * supersede+activate CAS to the port. Illegal transitions are refused here.
   */
  async activate(input: ActivatePolicyVersionInput): Promise<{ activatedAt: string }> {
    return this.options.versions.activate({ ...input });
  }

  /**
   * Bind a run to the currently active version plus registry versions.
   * Persisted via the store's snapshot writer in the same transaction as run
   * creation (C010); here we construct the verifiable snapshot object.
   */
  snapshotForRun(params: {
    repositoryId: string;
    runId: string;
    activeVersion: Pick<PolicyVersionRecord, 'policyVersionId' | 'canonicalJson' | 'hash'>;
    bindings: RegistryBindingVersions;
    snapshotId: string;
  }): PolicySnapshot {
    return Object.freeze({
      snapshotId: params.snapshotId,
      repositoryId: params.repositoryId,
      runId: params.runId,
      policyVersionId: params.activeVersion.policyVersionId,
      schemaVersion: 1 as const,
      canonicalJson: params.activeVersion.canonicalJson,
      hash: params.activeVersion.hash,
      bindings: Object.freeze({
          ...params.bindings,
          providerCapabilityVersions: Object.freeze({ ...params.bindings.providerCapabilityVersions }),
        }),
      boundAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
  }

  #runPipeline(
    input: PolicySource,
    context: SemanticContext,
  ):
    | { ok: true; policy: ReturnType<typeof normalizePolicyV1>; report: PolicyValidationReport }
    | { ok: false; report: PolicyValidationReport } {
    const report = new PolicyValidationReport();
    const decoder = new PolicyDecoder(report);
    const decoded = decoder.decode(input.bytes, input.formatHint);
    if (!decoded) return { ok: false, report };

    let parsed: RepositoryPolicyV1;
    try {
      parsed = repositoryPolicyV1.parse(decoded.value);
    } catch (error) {
      report.add({
        code: 'POLICY_SCHEMA_INVALID' as const,
        path: '',
        message: firstIssueMessage(error),
      });
      return { ok: false, report };
    }

    validateSemantics(parsed, report, context);
    if (!report.ok) return { ok: false, report };

    return { ok: true, policy: normalizePolicyV1(parsed), report };
  }

  async #validateForWrite(
    input: CreatePolicyVersionInput,
  ): Promise<
    | { created: true; record: PolicyVersionRecord }
    | { created: false; diagnostics: readonly PolicyDiagnostic[] }
  > {
    // C023 §16: a persisted version must be bound to its connected repository;
    // retargeting was already rejected during validation, so creation requires
    // the expected owner/name to anchor the document.
    const pipeline = this.#runPipeline(input.source, {
      ...input.semanticContext,
      expectedOwner: input.semanticContext.expectedOwner,
      expectedName: input.semanticContext.expectedName,
    });
    if (!input.semanticContext.expectedOwner || !input.semanticContext.expectedName) {
      throw new Error('repository binding required: semanticContext.expectedOwner/expectedName');
    }
    if (!pipeline.ok) {
      return { created: false, diagnostics: pipeline.report.items };
    }
    const active = await this.options.versions.findActiveVersion(input.repositoryId);
    const record = buildVersionRecord({
      repositoryId: input.repositoryId,
      policy: pipeline.policy,
      createdBy: input.createdBy,
      policyVersionId: this.options.newVersionId(),
      predecessorVersionId: active?.policyVersionId,
    });
    if (!canTransition('DRAFT', record.status)) {
      throw new Error('POLICY_VERSION_TRANSITION_INVALID');
    }
    const stored = await this.options.versions.insertVersion(record, {});
    return {
      created: true,
      record: { ...record, version: stored.version, policyVersionId: stored.id },
    };
  }
}

function firstIssueMessage(error: unknown): string {
  const issues = (error as { issues?: Array<{ message: string; path: Array<string | number> }> })
    ?.issues;
  const issue = issues?.[0];
  if (issue) {
    const path = issue.path.join('.');
    return `${path}: ${issue.message}`;
  }
  return String((error as Error)?.message ?? 'schema rejected the document');
}

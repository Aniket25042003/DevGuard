/**
 * C015 §8/§10 — repository map contracts.
 *
 * A `RepositoryMap` is an exact-ref-anchored, budget-bounded summary of a
 * repository. Every `MapFact` carries provenance (provider, resource,
 * immutable ref/SHA, path range, fetchedAt, content hash) and a trust label;
 * large/raw content is an artifact reference, never embedded. All repository
 * content is UNTRUSTED data; instructions are `instruction_candidate` facts
 * that C016 may pick up — they never gain authority here.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const REPOSITORY_MAP_SCHEMA_VERSION = 1 as const;

/** Map lifecycle states (C015 §9); terminal: complete/partial/failed/superseded. */
export const REPOSITORY_MAP_STATUSES = [
  'queued',
  'collecting',
  'assembling',
  'complete',
  'partial',
  'failed',
  'superseded',
] as const;
export type RepositoryMapStatus = (typeof REPOSITORY_MAP_STATUSES)[number];

export const MAP_TERMINAL_STATUSES: readonly RepositoryMapStatus[] = [
  'complete',
  'partial',
  'failed',
  'superseded',
];

/** Fact kinds (C015 §8). */
export const MAP_FACT_KINDS = [
  'tree_summary',
  'language',
  'manifest',
  'command_candidate',
  'ci_workflow',
  'instruction_candidate',
  'recent_commit',
  'linked_context',
  'targeted_path',
  'warning',
] as const;
export type MapFactKind = (typeof MAP_FACT_KINDS)[number];

/**
 * Trust labels (C015 §8 + C016 §4): repository-derived text is untrusted;
 * instruction-bearing files carry the explicit `instruction_candidate` label
 * and are filtered for authority by C016, never trusted by origin name.
 */
export const MAP_TRUST_LABELS = ['untrusted_data', 'instruction_candidate'] as const;
export type MapTrustLabel = (typeof MAP_TRUST_LABELS)[number];

/** Budget kinds tracked centrally (C015 §12/§22). */
export const BUDGET_KINDS = ['requests', 'paths', 'bytes', 'deadline'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface MapBudget {
  readonly maxRequests: number;
  readonly maxPaths: number;
  readonly maxBytes: number;
  readonly deadlineMs: number;
}

export interface MapProvenance {
  readonly provider: 'github';
  /** Normalized resource identifier, e.g. `repositories/octo/demo/git/trees/<sha>`. */
  readonly resource: string;
  /** Exact immutable ref binding: map facts never float on a moving ref. */
  readonly immutableRef: string;
  readonly path?: string | undefined;
  readonly lineRange?: { readonly start: number; readonly end: number } | undefined;
  readonly fetchedAtIso: string;
  readonly contentHash: string;
}

export interface MapFact {
  readonly id: string;
  readonly kind: MapFactKind;
  /** Normalized, bounded value shape (never raw provider payloads). */
  readonly value: Readonly<Record<string, unknown>>;
  readonly provenance: MapProvenance;
  readonly trust: MapTrustLabel;
  /** Deterministic heuristic confidence 0..1; never a safety statement. */
  readonly confidence: number;
  readonly sizeBytes?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly warning?: string | undefined;
}

export interface MapTruncation {
  readonly treeTruncated: boolean;
  readonly bytesTruncated: boolean;
  readonly pathsTruncated: boolean;
  readonly reasons: readonly string[];
}

export interface CommandCandidate {
  readonly command: string;
  readonly purpose: 'build' | 'test' | 'lint' | 'typecheck' | 'unknown';
  readonly sourcePath: string;
  readonly confidence: number;
  /** Command candidates are NEVER safe by construction (C015 §5/§12). */
  readonly safeToExecute: false;
}

export interface RepositoryMap {
  readonly id: string;
  readonly repositoryDevguardId: string;
  readonly baseRef: string;
  /** Exact SHA the map is anchored to (C015 §25: never a moving ref). */
  readonly headSha: string;
  readonly taskFingerprint: string;
  readonly schemaVersion: 1;
  readonly status: RepositoryMapStatus;
  readonly generatedAtIso: string;
  readonly expiresAtIso: string;
  readonly budgets: MapBudget;
  readonly truncation: MapTruncation;
  readonly languages: readonly LanguageProjection[];
  readonly treeSummary?: TreeSummary | undefined;
  readonly manifests: readonly ManifestRecord[];
  readonly commands: readonly CommandCandidate[];
  readonly ciWorkflows: readonly CiWorkflowRecord[];
  readonly instructionCandidates: readonly InstructionCandidateRecord[];
  readonly recentCommits: readonly CommitRecord[];
  readonly linkedContext: readonly LinkedContextRecord[];
  readonly targetedPaths: readonly TargetedPath[];
  /** Evidence references only; never embedded raw content. */
  readonly evidenceRefs: readonly string[];
  readonly facts: readonly MapFact[];
  readonly warnings: readonly string[];
  readonly headVerifiedAtIso?: string | undefined;
  readonly operationKey: string;
}

export interface RepositoryMapRef {
  readonly mapId: string;
  readonly repositoryDevguardId: string;
  readonly headSha: string;
  readonly status: RepositoryMapStatus;
}

export interface LanguageProjection {
  readonly name: string;
  readonly bytes: number;
  readonly fraction: number;
}

export interface TreeSummary {
  readonly totalFiles: number;
  readonly totalDirs: number;
  readonly topLevelDirs: readonly { readonly path: string; readonly fileCount: number }[];
  readonly largestFiles: readonly { readonly path: string; readonly sizeBytes: number }[];
  readonly vendorFileCount: number;
}

export interface ManifestRecord {
  readonly path: string;
  readonly kind:
    | 'npm'
    | 'pnpm_workspace'
    | 'yarn'
    | 'go'
    | 'rust'
    | 'python'
    | 'maven'
    | 'gradle'
    | 'ruby'
    | 'elixir'
    | 'php'
    | 'dockerfile'
    | 'github_actions';
  readonly packageManager?: string | undefined;
  readonly confidence: number;
}

export interface CiWorkflowRecord {
  readonly path: string;
  readonly workflowName?: string | undefined;
  readonly confidence: number;
}

export interface InstructionCandidateRecord {
  readonly path: string;
  readonly kind: 'agents' | 'cursor' | 'copilot' | 'readme' | 'contributing' | 'docs';
  readonly sizeBytes?: number | undefined;
  readonly contentHash: string;
  readonly artifactRef: string;
  readonly fetched: boolean;
}

export interface CommitRecord {
  readonly sha: string;
  /** Short redacted summary for context; never treated as authority. */
  readonly messageBrief: string;
  readonly authorLogin: string;
  readonly committedAtIso: string;
}

export interface LinkedContextRecord {
  readonly kind: 'issue' | 'pull_request';
  readonly externalKey: string;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'unknown';
}

export interface TargetedPath {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface BuildRepositoryMap {
  readonly repositoryId: string;
  readonly ref: string;
  readonly workflowRunId: string;
  readonly task: {
    readonly kind: string;
    readonly terms: readonly string[];
    readonly issueNumber?: number | undefined;
    readonly prNumber?: number | undefined;
  };
  readonly budget: MapBudget;
  readonly operationKey: string;
}

export interface QueryRepositoryMap {
  readonly mapId: string;
  readonly kinds?: readonly MapFactKind[] | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly limit: number;
}

export interface MapQueryResult {
  readonly mapId: string;
  readonly headSha: string;
  readonly status: RepositoryMapStatus;
  readonly facts: readonly MapFact[];
  readonly evidenceRefs: readonly string[];
  readonly truncation: { readonly returnedCount: number; readonly totalCount: number };
}

export interface InvalidateRepositoryMap {
  readonly repositoryId: string;
  readonly reason: 'push' | 'default_branch_changed' | 'manual' | 'policy_change';
}

// ---- boundary schemas (zod v4, strict boundaries) ---------------------------

export const mapBudgetSchema = z
  .object({
    maxRequests: z.number().int().min(1).max(10_000),
    maxPaths: z.number().int().min(1).max(10_000),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024 * 1024),
    deadlineMs: z
      .number()
      .int()
      .min(1)
      .max(60 * 60 * 1000),
  })
  .strict();

export const buildRepositoryMapSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    ref: z.string().min(1).max(256),
    workflowRunId: idSchemas.workflowRunId,
    task: z
      .object({
        kind: z.string().min(1).max(64),
        terms: z.array(z.string().min(1).max(128)).max(32),
        issueNumber: z.number().int().positive().max(10_000_000).optional(),
        prNumber: z.number().int().positive().max(10_000_000).optional(),
      })
      .strict(),
    budget: mapBudgetSchema,
    operationKey: idSchemas.operationKey,
  })
  .strict();

export const queryRepositoryMapSchema = z
  .object({
    mapId: z.string().min(1).max(128),
    kinds: z.array(z.enum(MAP_FACT_KINDS)).max(16).optional(),
    paths: z.array(z.string().min(1).max(1024)).max(64).optional(),
    limit: z.number().int().min(1).max(500),
  })
  .strict();

export const invalidateRepositoryMapSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    reason: z.enum(['push', 'default_branch_changed', 'manual', 'policy_change']),
  })
  .strict();

export type BuildRepositoryMapInput = z.output<typeof buildRepositoryMapSchema>;
export type QueryRepositoryMapInput = z.output<typeof queryRepositoryMapSchema>;
export type InvalidateRepositoryMapInput = z.output<typeof invalidateRepositoryMapSchema>;

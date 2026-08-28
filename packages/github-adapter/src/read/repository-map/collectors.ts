/**
 * C015 §12/§23 — the map collector pipeline.
 *
 * Transforms a resolved exact-ref provider read into bounded, provenance-
 * labelled evidence: tree summary, language projections, manifests, command
 * candidates, CI descriptors, instruction candidates (bounded fetches, artifact
 * references), recent commits, linked context, and targeted paths. Every
 * provider request, path, byte, and the deadline are charged to the central
 * BudgetTracker; on exhaustion collection truncates and the map assembles as
 * `partial` — never false completion. Nothing here executes a command or trusts
 * instruction content (C015 §5/§25).
 */
import { createHash } from 'node:crypto';
import type { BudgetTracker } from './budget.js';
import type {
  CiWorkflowRecord,
  CommandCandidate,
  CommitRecord,
  InstructionCandidateRecord,
  LanguageProjection,
  LinkedContextRecord,
  ManifestRecord,
  MapFact,
  MapProvenance,
  MapTruncation,
  TargetedPath,
} from './contracts.js';
import {
  CiDescriptorCollector,
  CommandCandidateDetector,
  InstructionCandidateCollector,
  ManifestDetector,
} from './detectors.js';
import type { MapArtifactRef, MapArtifactStorePort } from '../ports/map-artifact-store.js';
import type { RepositoryContentProviderPort } from './provider-port.js';
import { TargetRanker } from './target-ranker.js';
import { TreeCollector } from './tree-summary.js';

export const MAX_LANGUAGES = 10;
export const MAX_INSTRUCTION_CANDIDATES = 5;
export const MAX_RECENT_COMMITS = 20;
export const MAX_TARGETED_PATHS = 20;
export const INSTRUCTION_FETCH_BYTES_CAP = 64 * 1024;

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  cs: 'C#',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  php: 'PHP',
  swift: 'Swift',
  scala: 'Scala',
  md: 'Markdown',
  yml: 'YAML',
  yaml: 'YAML',
  json: 'JSON',
  toml: 'TOML',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  dockerfile: 'Docker',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  vue: 'Vue',
  sql: 'SQL',
  proto: 'Protobuf',
};

const EXT_PATTERN = /\.([^.]+)$/;

interface LanguageAccumulator {
  readonly name: string;
  bytes: number;
}

export interface CollectedEvidence {
  readonly languages: readonly LanguageProjection[];
  readonly treeSummary: ReturnType<TreeCollector['collect']>['summary'];
  readonly manifests: readonly ManifestRecord[];
  readonly commands: readonly CommandCandidate[];
  readonly ciWorkflows: readonly CiWorkflowRecord[];
  readonly instructionCandidates: readonly InstructionCandidateRecord[];
  readonly recentCommits: readonly CommitRecord[];
  readonly linkedContext: readonly LinkedContextRecord[];
  readonly targetedPaths: readonly TargetedPath[];
  readonly facts: readonly MapFact[];
  readonly warnings: readonly string[];
  readonly truncation: MapTruncation;
  readonly partial: boolean;
}

export interface CollectEvidenceInput {
  readonly repositoryDevguardId: string;
  readonly headSha: string;
  readonly provider: RepositoryContentProviderPort;
  readonly budget: BudgetTracker;
  readonly artifactStore: MapArtifactStorePort;
  readonly task: {
    readonly kind: string;
    readonly terms: readonly string[];
    readonly issueNumber?: number | undefined;
    readonly prNumber?: number | undefined;
  };
  readonly nowMs: number;
  readonly nowIso: string;
  readonly correlationId: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenanceFor(
  resource: string,
  headSha: string,
  nowIso: string,
  path?: string,
): MapProvenance {
  return {
    provider: 'github',
    resource,
    immutableRef: headSha,
    ...(path !== undefined ? { path } : {}),
    fetchedAtIso: nowIso,
    contentHash: sha256Hex(`${resource}:${headSha}:${path ?? ''}`),
  };
}

function languagesFromSizes(sizeByPath: ReadonlyMap<string, number>): LanguageProjection[] {
  const accumulators = new Map<string, LanguageAccumulator>();
  let totalBytes = 0;
  for (const [path, size] of sizeByPath) {
    const match = EXT_PATTERN.exec(path);
    if (match === null) continue;
    const ext = match[1]?.toLowerCase();
    if (ext === undefined) continue;
    const language = LANGUAGE_BY_EXT[ext];
    if (language === undefined) continue;
    const accumulator = accumulators.get(language) ?? { name: language, bytes: 0 };
    accumulator.bytes += size;
    accumulators.set(language, accumulator);
    totalBytes += size;
  }
  const projections: LanguageProjection[] = [...accumulators.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MAX_LANGUAGES)
    .map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      fraction: totalBytes > 0 ? roundTo(entry.bytes / totalBytes) : 0,
    }));
  return projections;
}

function roundTo(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Collect all map evidence from a provider within the central budget. Returns
 * normalized, provenance-labelled facts plus an explicit partial flag and the
 * truncation report. Ordering is deterministic (stable by path where relevant).
 */
export async function collectRepositoryMapEvidence(
  input: CollectEvidenceInput,
): Promise<CollectedEvidence> {
  const { provider, budget, nowMs, nowIso, headSha } = input;
  const facts: MapFact[] = [];
  const warnings: string[] = [];
  let bytesTruncated = false;
  let pathsTruncated = false;

  // 1. Tree (recursive) under budget. Charge the request before the read so
  // the central request budget is never exceeded (C015 §23 step 3).
  if (!budget.chargeRequest()) {
    return {
      languages: [],
      treeSummary: emptyTree(),
      manifests: [],
      commands: [],
      ciWorkflows: [],
      instructionCandidates: [],
      recentCommits: [],
      linkedContext: [],
      targetedPaths: [],
      facts: [],
      warnings: ['request budget exhausted before tree read'],
      truncation: {
        treeTruncated: true,
        bytesTruncated: false,
        pathsTruncated: false,
        reasons: ['requests'],
      },
      partial: true,
    };
  }
  const treeResult = await provider.listTree({ commitSha: headSha });
  if (!treeResult.ok) {
    return {
      languages: [],
      treeSummary: emptyTree(),
      manifests: [],
      commands: [],
      ciWorkflows: [],
      instructionCandidates: [],
      recentCommits: [],
      linkedContext: [],
      targetedPaths: [],
      facts: [],
      warnings: [`provider tree read failed: ${treeResult.code}`],
      truncation: {
        treeTruncated: true,
        bytesTruncated: false,
        pathsTruncated: false,
        reasons: [`tree:${treeResult.code}`],
      },
      partial: true,
    };
  }
  const tree = new TreeCollector().collect(treeResult.value.entries, budget, nowMs);
  const entries = treeResult.value.entries;
  const sizeByPath = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'blob' && entry.size !== undefined) {
      sizeByPath.set(entry.path, entry.size);
    }
  }

  const retained = tree.retainedPaths;
  const summary = tree.summary;
  facts.push({
    id: `fact-tree-${headSha.slice(0, 8)}`,
    kind: 'tree_summary',
    value: { totalFiles: summary.totalFiles, totalDirs: summary.totalDirs },
    provenance: provenanceFor(
      `repositories/${input.repositoryDevguardId}/git/trees/${headSha}`,
      headSha,
      nowIso,
    ),
    trust: 'untrusted_data',
    confidence: 1,
  });

  // 2. Languages from retained blob sizes.
  const languageSize = new Map<string, number>();
  for (const path of retained) {
    const size = sizeByPath.get(path);
    if (size !== undefined) languageSize.set(path, size);
  }
  const languages = languagesFromSizes(languageSize);

  // 3. Manifests + command candidates + CI + instruction candidates (bounded).
  const manifests: ManifestRecord[] = [];
  const commands: CommandCandidate[] = [];
  const ciWorkflows: CiWorkflowRecord[] = [];
  const manifestDetector = new ManifestDetector();
  const commandDetector = new CommandCandidateDetector();
  const ciDetector = new CiDescriptorCollector();
  const instructionCollector = new InstructionCandidateCollector();
  for (const path of retained) {
    if (budget.isExhausted(nowMs).length > 0) {
      pathsTruncated = true;
      warnings.push('path budget exhausted during detection');
      break;
    }
    const manifest = manifestDetector.detect(path);
    if (manifest !== undefined) {
      manifests.push(manifest);
      commands.push(...commandDetector.detectFor(manifest.kind, manifest.path));
    }
    const ci = ciDetector.detect(path);
    if (ci !== undefined) ciWorkflows.push(ci);
  }

  const instructionCandidates: InstructionCandidateRecord[] = [];
  const instructionCandidatesFound: Array<{
    path: string;
    kind: InstructionCandidateRecord['kind'];
  }> = [];
  for (const path of retained) {
    if (budget.isExhausted(nowMs).length > 0) break;
    const detected = instructionCollector.detect(path);
    if (detected !== undefined) {
      instructionCandidatesFound.push({ path, kind: detected.kind });
    }
  }
  // Fetch the top instruction candidates (bounded) and write checksummed artifacts.
  const chosen = instructionCandidatesFound.slice(0, MAX_INSTRUCTION_CANDIDATES);
  for (const candidate of chosen) {
    if (budget.isExhausted(nowMs).length > 0) {
      bytesTruncated = true;
      warnings.push(`instruction candidate artifact skipped (${candidate.path})`);
      break;
    }
    if (!budget.chargeRequest()) {
      bytesTruncated = true;
      warnings.push(`instruction candidate request budget exceeded (${candidate.path})`);
      break;
    }
    const read = await provider.readFileBytes({ commitSha: headSha, path: candidate.path });
    if (!read.ok) {
      instructionCandidates.push(
        instructionCollector.buildRecord(
          candidate.path,
          candidate.kind,
          undefined,
          `ref:${candidate.path}`,
        ),
      );
      continue;
    }
    const content = read.value.content.slice(0, INSTRUCTION_FETCH_BYTES_CAP);
    if (!budget.chargeBytes(content.length)) {
      bytesTruncated = true;
      warnings.push(`instruction candidate byte budget exceeded (${candidate.path})`);
    }
    const artifact: MapArtifactRef = await input.artifactStore.writeBlob(content);
    instructionCandidates.push(
      instructionCollector.buildRecord(
        candidate.path,
        candidate.kind,
        content,
        artifact.artifactRef,
      ),
    );
    facts.push({
      id: `fact-instruction-${sha256Hex(candidate.path).slice(0, 8)}`,
      kind: 'instruction_candidate',
      value: { path: candidate.path, kind: candidate.kind },
      provenance: provenanceFor(
        `repositories/${input.repositoryDevguardId}/git/blobs/${headSha}`,
        headSha,
        nowIso,
        candidate.path,
      ),
      trust: 'instruction_candidate',
      confidence: 0.6,
      sizeBytes: content.length,
    });
  }

  // 4. Recent commits + linked context.
  const commits: CommitRecord[] = [];
  if (budget.chargeRequest()) {
    const commitsResult = await provider.readRecentCommits({
      commitSha: headSha,
      max: MAX_RECENT_COMMITS,
    });
    if (commitsResult.ok) commits.push(...commitsResult.value);
  }
  const linkedContext: LinkedContextRecord[] = [];
  if (budget.chargeRequest()) {
    const linkedResult = await provider.readLinkedContext({
      issueNumber: input.task.issueNumber,
      prNumber: input.task.prNumber,
    });
    if (linkedResult.ok) linkedContext.push(...linkedResult.value);
  }

  // 5. Targeted paths.
  const ranker = new TargetRanker();
  const ranking = ranker.rank(
    retained.map((path) => ({ path, terms: input.task.terms })),
    input.task.terms,
    budget,
    nowMs,
  );
  const targetedPaths = ranking.targetedPaths.slice(0, MAX_TARGETED_PATHS);

  const truncation: MapTruncation = {
    treeTruncated: tree.truncated || treeResult.value.truncated,
    bytesTruncated,
    pathsTruncated: pathsTruncated || ranking.truncated,
    reasons: [...warnings],
  };

  // 6. Fact provenance propagation to remaining evidence buckets.
  for (const manifest of manifests) {
    facts.push({
      id: `fact-manifest-${sha256Hex(manifest.path).slice(0, 8)}`,
      kind: 'manifest',
      value: { path: manifest.path, kind: manifest.kind },
      provenance: provenanceFor(
        `repositories/${input.repositoryDevguardId}/git/trees/${headSha}`,
        headSha,
        nowIso,
        manifest.path,
      ),
      trust: 'untrusted_data',
      confidence: manifest.confidence,
    });
  }

  return {
    languages,
    treeSummary: summary,
    manifests,
    commands,
    ciWorkflows,
    instructionCandidates,
    recentCommits: commits,
    linkedContext,
    targetedPaths,
    facts,
    warnings,
    truncation,
    partial:
      truncation.treeTruncated ||
      truncation.bytesTruncated ||
      truncation.pathsTruncated ||
      warnings.length > 0,
  };
}

/** Empty, structurally-valid TreeSummary used before any tree is available. */
function emptyTree(): ReturnType<TreeCollector['collect']>['summary'] {
  return { totalFiles: 0, totalDirs: 0, topLevelDirs: [], largestFiles: [], vendorFileCount: 0 };
}

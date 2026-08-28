/**
 * C015 §12/§23 step 4 — deterministic heuristic detectors.
 *
 * Manifests, command candidates, CI workflows and instruction candidates are
 * detected from normalized paths (and, for manifests, bounded file content).
 * Detected commands are CANDIDATES ONLY: `safeToExecute` is always false and
 * nothing here executes or marks anything safe (C015 §5/§25). Instruction
 * candidates carry the `instruction_candidate` label for C016; they never
 * gain authority by being detected.
 */
import { createHash } from 'node:crypto';
import type {
  CiWorkflowRecord,
  CommandCandidate,
  InstructionCandidateRecord,
  ManifestRecord,
} from './contracts.js';

interface ManifestRule {
  readonly pathMatcher: RegExp;
  readonly kind: ManifestRecord['kind'];
  readonly packageManager?: string | undefined;
  readonly confidence: number;
}

const MANIFEST_RULES: readonly ManifestRule[] = [
  {
    pathMatcher: /^pnpm-workspace\.yaml$/,
    kind: 'pnpm_workspace',
    packageManager: 'pnpm',
    confidence: 0.9,
  },
  { pathMatcher: /^package\.json$/, kind: 'npm', confidence: 0.7 },
  { pathMatcher: /^yarn\.lock$/, kind: 'yarn', packageManager: 'yarn', confidence: 0.9 },
  { pathMatcher: /^go\.mod$/, kind: 'go', confidence: 0.9 },
  { pathMatcher: /^Cargo\.toml$/, kind: 'rust', confidence: 0.9 },
  { pathMatcher: /^pyproject\.toml$/, kind: 'python', confidence: 0.8 },
  { pathMatcher: /^requirements.*\.txt$/, kind: 'python', confidence: 0.7 },
  { pathMatcher: /^pom\.xml$/, kind: 'maven', confidence: 0.9 },
  { pathMatcher: /^build\.gradle(?:\.kts)?$/, kind: 'gradle', confidence: 0.9 },
  { pathMatcher: /^Gemfile$/, kind: 'ruby', confidence: 0.85 },
  { pathMatcher: /^mix\.exs$/, kind: 'elixir', confidence: 0.9 },
  { pathMatcher: /^composer\.json$/, kind: 'php', confidence: 0.85 },
  { pathMatcher: /^Dockerfile(?:[.\w-]*)?$/, kind: 'dockerfile', confidence: 0.8 },
  {
    pathMatcher: /^\.github\/workflows\/[^/]+\.(?:ya?ml)$/,
    kind: 'github_actions',
    confidence: 0.95,
  },
];

/** Command template before source binding (no sourcePath, never safe). */
type CommandTemplate = Omit<CommandCandidate, 'sourcePath' | 'safeToExecute'>;

/** Commands inferred from a manifest kind (path heuristics, no execution). */
const COMMAND_CANDIDATES: Readonly<Record<ManifestRecord['kind'], readonly CommandTemplate[]>> = {
  npm: [
    { command: 'npm run build', purpose: 'build', confidence: 0.5 },
    { command: 'npm test', purpose: 'test', confidence: 0.6 },
    { command: 'npm run lint', purpose: 'lint', confidence: 0.4 },
  ],
  pnpm_workspace: [
    { command: 'pnpm --filter <pkg> build', purpose: 'build', confidence: 0.5 },
    { command: 'pnpm --filter <pkg> test', purpose: 'test', confidence: 0.6 },
  ],
  yarn: [
    { command: 'yarn build', purpose: 'build', confidence: 0.5 },
    { command: 'yarn test', purpose: 'test', confidence: 0.6 },
  ],
  go: [
    { command: 'go build ./...', purpose: 'build', confidence: 0.8 },
    { command: 'go test ./...', purpose: 'test', confidence: 0.85 },
    { command: 'go vet ./...', purpose: 'lint', confidence: 0.7 },
  ],
  rust: [
    { command: 'cargo build', purpose: 'build', confidence: 0.85 },
    { command: 'cargo test', purpose: 'test', confidence: 0.85 },
    { command: 'cargo clippy -- -D warnings', purpose: 'lint', confidence: 0.7 },
  ],
  python: [{ command: 'pytest', purpose: 'test', confidence: 0.5 }],
  maven: [
    { command: 'mvn package', purpose: 'build', confidence: 0.6 },
    { command: 'mvn test', purpose: 'test', confidence: 0.6 },
  ],
  gradle: [
    { command: 'gradle build', purpose: 'build', confidence: 0.7 },
    { command: 'gradle test', purpose: 'test', confidence: 0.7 },
  ],
  ruby: [{ command: 'bundle exec rspec', purpose: 'test', confidence: 0.5 }],
  elixir: [{ command: 'mix test', purpose: 'test', confidence: 0.8 }],
  php: [{ command: 'composer test', purpose: 'test', confidence: 0.4 }],
  dockerfile: [],
  github_actions: [],
};

const INSTRUCTION_CANDIDATE_RULES: Readonly<
  Array<{ matcher: RegExp; kind: InstructionCandidateRecord['kind'] }>
> = [
  { matcher: /(^|\/)AGENTS\.md$/, kind: 'agents' },
  { matcher: /(^|\/)CLAUDE\.md$/, kind: 'agents' },
  { matcher: /^\.cursor\/rules\/.+\.md$/, kind: 'cursor' },
  { matcher: /(^|\/)\.github\/copilot-instructions\.md$/, kind: 'copilot' },
  { matcher: /(^|\/)README\.md$/, kind: 'readme' },
  { matcher: /(^|\/)CONTRIBUTING\.md$/, kind: 'contributing' },
  { matcher: /^docs\/.+\.md$/, kind: 'docs' },
];

const CI_WORKFLOW_RULE = /^\.github\/workflows\/[^/]+\.(?:ya?ml)$/;

export class ManifestDetector {
  detect(path: string): ManifestRecord | undefined {
    const basename = path.split('/').pop() ?? path;
    void basename;
    for (const rule of MANIFEST_RULES) {
      if (rule.pathMatcher.test(path)) {
        return {
          path,
          kind: rule.kind,
          ...(rule.packageManager !== undefined ? { packageManager: rule.packageManager } : {}),
          confidence: rule.confidence,
        };
      }
    }
    return undefined;
  }
}

export class CommandCandidateDetector {
  /** Returns candidates for a manifest kind with the manifest as source. */
  detectFor(kind: ManifestRecord['kind'], sourcePath: string): readonly CommandCandidate[] {
    const base = COMMAND_CANDIDATES[kind] ?? [];
    return base.map((candidate) => ({
      command: candidate.command,
      purpose: candidate.purpose,
      sourcePath,
      confidence: candidate.confidence,
      safeToExecute: false as const,
    }));
  }
}

export class CiDescriptorCollector {
  detect(path: string): CiWorkflowRecord | undefined {
    if (!CI_WORKFLOW_RULE.test(path)) return undefined;
    return { path, confidence: 0.95 };
  }
}

export class InstructionCandidateCollector {
  detect(path: string): { kind: InstructionCandidateRecord['kind'] } | undefined {
    for (const rule of INSTRUCTION_CANDIDATE_RULES) {
      if (rule.matcher.test(path)) return { kind: rule.kind };
    }
    return undefined;
  }

  buildRecord(
    path: string,
    kind: InstructionCandidateRecord['kind'],
    fetchedContent: string | undefined,
    artifactRef: string,
  ): InstructionCandidateRecord {
    return {
      path,
      kind,
      ...(fetchedContent !== undefined
        ? { sizeBytes: Buffer.byteLength(fetchedContent, 'utf8') }
        : {}),
      contentHash: fetchedContent === undefined ? sha256Hex(path) : sha256Hex(fetchedContent),
      artifactRef,
      fetched: fetchedContent !== undefined,
    };
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

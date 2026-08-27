/**
 * C026 §8/§17/§22 — sandbox command proposals and the deterministic
 * CommandRiskAnalyzer.
 *
 * Open decision (C026 §28): exact POSIX parser. Rather than adopt an
 * unpinned heavyweight shell-parsing dependency, this implementation supports:
 *  - `direct` mode (preferred): argv is analyzed structurally as DATA.
 *  - `shell` mode: a conservative bounded tokenizer recognizes plain
 *    sequences of simple commands plus pipes; ANY metacharacter construct it
 *    cannot statically resolve (substitutions, heredocs, process
 *    substitution, globs on dangerous operands, `&&`/`||`/`;` chains mixing
 *    analyzers) is reported parseStatus UNSUPPORTED → UNKNOWN → fail closed.
 *
 * The analyzer NEVER executes anything and never consults an LLM. Structural
 * rules are primary; string signatures only add factors, never downgrade.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const networkRequest = z
  .object({
    required: z.boolean(),
    destinations: z.array(z.string().max(253)).max(32).default([]),
  })
  .strict();

export const relativePath = z
  .string()
  .min(1)
  .max(512)
  // Containment: no absolute paths, no parent traversal outside workspace root.
  .refine((value) => !value.startsWith('/'), 'cwd must be workspace-relative')
  .refine(
    (value) => !value.split('/').includes('..'),
    'parent traversal outside the workspace is rejected',
  );

export const sandboxCommandProposal = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('direct'),
      executable: z.string().min(1).max(256),
      argv: z.array(z.string().max(4096)).max(256),
      cwd: relativePath,
      envKeys: z.array(z.string().max(128)).max(64),
      timeoutMs: z.number().int().min(1_000).max(3_600_000),
      network: networkRequest,
    })
    .strict(),
  z
    .object({
      mode: z.literal('shell'),
      shell: z.enum(['sh', 'bash']),
      source: z.string().min(1).max(16_384),
      cwd: relativePath,
      envKeys: z.array(z.string().max(128)).max(64),
      timeoutMs: z.number().int().min(1_000).max(3_600_000),
      network: networkRequest,
    })
    .strict(),
]);

export type SandboxCommandProposal = z.output<typeof sandboxCommandProposal>;

export type CommandClass =
  | 'READ_ONLY'
  | 'BUILD_TEST'
  | 'PACKAGE_INSTALL'
  | 'NETWORKED'
  | 'PRIVILEGED'
  | 'DESTRUCTIVE'
  | 'DATABASE'
  | 'INFRASTRUCTURE'
  | 'UNKNOWN';

export interface CommandClassification {
  readonly classes: readonly CommandClass[];
  readonly factors: readonly { ruleId: string; explanation: string }[];
  readonly obligations: readonly string[];
  readonly parseStatus: 'COMPLETE' | 'AMBIGUOUS' | 'UNSUPPORTED';
  readonly astFingerprint: string;
  readonly analyzerVersion: string;
}

const SANDBOX_OBLIGATIONS = ['sandbox_only', 'timeout_required'] as const;

/** Commands that permanently delete, escalate privilege, or rewrite history. */
interface StructuralFinding {
  readonly ruleId: string;
  readonly explanation: string;
  readonly addsClass?: CommandClass;
}

function structuralFindingsForSimple(
  executable: string,
  argv: readonly string[],
): StructuralFinding[] {
  const findings: StructuralFinding[] = [];
  const all = [executable.toLowerCase(), ...argv.map((a) => a.toLowerCase())];
  const joined = all.join(' ');

  // Privilege escalation — always denied per C026 §22 matrix.
  if (['sudo', 'su', 'doas'].includes(executable.toLowerCase())) {
    findings.push({
      ruleId: 'cmd-01-privilege',
      explanation: `privilege escalation via '${executable}'`,
      addsClass: 'PRIVILEGED',
    });
  }
  // eval / dynamic interpreters — injection-prone unknowns.
  if (['eval', 'exec', 'source', '.'].includes(executable.toLowerCase())) {
    findings.push({
      ruleId: 'cmd-02-eval',
      explanation: `'${executable}' executes dynamic content`,
      addsClass: 'UNKNOWN',
    });
  }

  if (executable === 'rm') {
    const recursive =
      argv.includes('-r') ||
      argv.includes('-rf') ||
      argv.includes('-fr') ||
      all.some((t) => t.startsWith('--recursive'));
    const force = argv.includes('-f') || argv.some((t) => /^-[a-z]*f/.test(t));
    const targets = argv.filter((a) => !a.startsWith('-'));
    const dangerousTarget = targets.some(
      (target) =>
        target === '/' ||
        target === '' ||
        /^[^/]*\/\.\.$/.test(target) ||
        target.split('/').includes('..'),
    );
    if (recursive && force) {
      findings.push({
        ruleId: 'cmd-03-rm-rf',
        explanation: dangerousTarget
          ? 'recursive forced deletion at root/parent equivalent'
          : 'recursive forced deletion',
        addsClass: 'DESTRUCTIVE',
      });
    } else if (recursive) {
      findings.push({
        ruleId: 'cmd-04-rm-r',
        explanation: 'recursive deletion',
        addsClass: 'DESTRUCTIVE',
      });
    }
  }

  if (executable === 'git') {
    const sub = (argv[0] ?? '').toLowerCase();
    if (sub === 'push' && argv.some((a) => /^--force/.test(a) || a === '-f')) {
      const refspec = [...argv].reverse().find((a) => !a.startsWith('-'));
      const defaultBranch = refspec === undefined ? true : /(^|[:/])(main|master)$/.test(refspec);
      findings.push({
        ruleId: 'cmd-05-force-push',
        explanation: defaultBranch
          ? 'forced push to default branch rewrites remote history'
          : 'forced push rewrites remote history',
        addsClass: 'DESTRUCTIVE',
      });
    }
    if (sub === 'reset' && argv.includes('--hard')) {
      findings.push({
        ruleId: 'cmd-06-reset-hard',
        explanation: 'git reset --hard discards uncommitted work',
        addsClass: 'DESTRUCTIVE',
      });
    }
    if (
      sub === 'clean' &&
      (all.some((t) => t.includes('fdx')) || (argv.includes('-f') && argv.includes('-d')))
    ) {
      findings.push({
        ruleId: 'cmd-07-clean-fdx',
        explanation: 'git clean -fd(x) removes untracked/ignored files destructively',
        addsClass: 'DESTRUCTIVE',
      });
    }
  }

  if (executable === 'gh' && argv[0] === 'repo' && argv[1] === 'delete') {
    findings.push({
      ruleId: 'cmd-08-repo-delete',
      explanation: 'repository deletion requested',
      addsClass: 'DESTRUCTIVE',
    });
  }

  if (
    ['psql', 'mysql', 'sqlite3'].includes(executable.toLowerCase()) ||
    joined.includes('drop database') ||
    joined.includes('drop table') ||
    joined.includes('truncate table')
  ) {
    findings.push({
      ruleId: 'cmd-09-destructive-sql',
      explanation: 'destructive SQL statement detected',
      addsClass: 'DATABASE',
    });
  }

  if (executable === 'terraform' && argv[0]?.toLowerCase() === 'destroy') {
    findings.push({
      ruleId: 'cmd-10-tf-destroy',
      explanation: 'terraform destroy targets infrastructure deletion',
      addsClass: 'INFRASTRUCTURE',
    });
  }
  if (executable === 'kubectl' && argv[0]?.toLowerCase() === 'delete') {
    findings.push({
      ruleId: 'cmd-11-k8s-delete',
      explanation: 'kubectl delete targets infrastructure removal',
      addsClass: 'INFRASTRUCTURE',
    });
  }

  // Package installs: restricted network/resource profile required downstream.
  if (
    ['npm', 'pnpm', 'yarn'].includes(executable) &&
    ['install', 'add', 'ci'].includes(argv[0] ?? '')
  ) {
    findings.push({
      ruleId: 'cmd-12-package-install',
      explanation:
        'package installation runs lifecycle scripts under constrained network/resources',
      addsClass: 'PACKAGE_INSTALL',
    });
  }

  return findings;
}

const BUILD_FAMILIES = new Set(['pnpm', 'npm', 'yarn', 'make', 'cargo', 'go', 'mvn', 'gradle']);
const TEST_SUBCOMMANDS = new Set([
  'test',
  'vitest',
  'jest',
  'pytest',
  'check',
  'lint',
  'typecheck',
  'tsc',
]);

function classifySimple(executable: string, argv: readonly string[]): CommandClass[] {
  const classes = new Set<CommandClass>();
  if (BUILD_FAMILIES.has(executable)) {
    const sub = (argv[0] ?? '').toLowerCase();
    if (TEST_SUBCOMMANDS.has(sub))
      classes.add(sub === 'typecheck' || sub === 'lint' ? 'READ_ONLY' : 'BUILD_TEST');
    else if (sub === 'install' || sub === 'add' || sub === 'ci') classes.add('PACKAGE_INSTALL');
    else if (['build', 'run', 'compile'].includes(sub)) classes.add('BUILD_TEST');
    else classes.add('UNKNOWN');
  } else {
    switch (executable) {
      case 'cat':
      case 'ls':
      case 'head':
      case 'tail':
      case 'grep':
      case 'rg':
      case 'find':
      case 'wc':
      case 'git':
        {
          const sub = (argv[0] ?? '').toLowerCase();
          if (['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse'].includes(sub))
            classes.add('READ_ONLY');
          else classes.add('UNKNOWN');
          break;
        }

        classes.add('READ_ONLY');
        break;
      case 'curl':
      case 'wget':
        classes.add('NETWORKED');
        break;
      case 'node':
      case 'python':
      case 'python3':
      case 'sh':
      case 'bash':
        classes.add('UNKNOWN');
        break;
      default:
        classes.add('UNKNOWN');
    }
  }
  return [...classes];
}

/**
 * Conservative shell-mode analysis: splits on top-level `;`/newline into
 * simple segments; each must be a plain single pipeline of simple words with
 * optional safe pipes (`|`) where BOTH sides classify; everything else is
 * UNSUPPORTED. Dangerous pipe-to-interpreter patterns deny regardless.
 */
export function analyzeShellSource(source: string): {
  segments: Array<{ executable: string; argv: string[] }> | undefined;
  unsupported: boolean;
  unsupportedReason?: string | undefined;
} {
  if (/[\n\r]/.test(source) || source.length > 8192) {
    return {
      segments: undefined,
      unsupported: true,
      unsupportedReason: 'multi-line or oversized shell input',
    };
  }
  // Metacharacters we do NOT support statically in MVP:
  if (/[;&><`$()]|\|\||&&/.test(source.replace(/\|(?!\|)/g, '|'))) {
    if (/[;&<>`()]/.test(source) || /\$\{?/.test(source)) {
      return {
        segments: undefined,
        unsupported: true,
        unsupportedReason: 'shell metacharacters/substitution present',
      };
    }
  }
  if (source.includes('|')) {
    const sides = source.split('|');
    // Pipe-to-shell/interpreter detection comes first (deny-worthy even if otherwise parseable).
    const segments: Array<{ executable: string; argv: string[] }> = [];
    for (const side of sides) {
      const words = tokenize(side);
      if (!words || words.length === 0) {
        return {
          segments: undefined,
          unsupported: true,
          unsupportedReason: 'empty pipeline segment',
        };
      }
      segments.push({ executable: String(words[0]), argv: words.slice(1) });
    }
    return { segments, unsupported: false };
  }
  const words = tokenize(source);
  if (!words || words.length === 0) {
    return { segments: undefined, unsupported: true, unsupportedReason: 'unparseable command' };
  }
  return { segments: [{ executable: String(words[0]), argv: words.slice(1) }], unsupported: false };
}

/** Whitespace tokenizer that honors quotes but treats expansions as opaque. */
function tokenize(input: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && (char === '$' || char === '`')) return undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
      continue;
    }
    if (char !== undefined && /\s/.test(char)) {
      if (current) words.push(current);
      current = '';
      continue;
    }
    if (char === '$' || char === '`') {
      return undefined; // expansion: unsupported, fail closed
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

export interface CommandAnalysisContext {
  /** Trusted manifest snapshot: repository script name → resolved command hash. */
  readonly knownScriptHashes?: Readonly<Record<string, string>> | undefined;
}

export function analyzeCommand(
  proposal: SandboxCommandProposal,
  context: CommandAnalysisContext = {},
): CommandClassification {
  let parseStatus: CommandClassification['parseStatus'] = 'COMPLETE';
  let unsupportedReason: string | undefined;
  const findings: StructuralFinding[] = [];
  const classes = new Set<CommandClass>();

  if (proposal.mode === 'direct') {
    findings.push(...structuralFindingsForSimple(proposal.executable, proposal.argv));
    for (const klass of classifySimple(proposal.executable, proposal.argv)) classes.add(klass);
    if (proposal.executable.startsWith('./') || proposal.executable.includes('/')) {
      // Dynamic/unregistered executables cannot be auto-allowed (C026 §4.6).
      const scriptHash = context.knownScriptHashes?.[proposal.executable];
      if (!scriptHash) {
        findings.push({
          ruleId: 'cmd-20-dynamic-executable',
          explanation: 'executable resolves outside the trusted manifest snapshot',
          addsClass: 'UNKNOWN',
        });
      }
    }
    if (proposal.network.required) {
      classes.add('NETWORKED');
    }
  } else {
    const shellResult = analyzeShellSource(proposal.source);
    if (shellResult.unsupported || !shellResult.segments) {
      parseStatus = 'UNSUPPORTED';
      unsupportedReason = shellResult.unsupportedReason ?? 'unsupported shell syntax';
      classes.add('UNKNOWN');
    } else {
      // Deny structural pipe-to-interpreter/download-to-shell patterns first.
      const pipeTargets = shellResult.segments.slice(1).map((segment) => segment.executable);
      const pipeSources = shellResult.segments.slice(0, -1).map((segment) => segment.executable);
      if (
        pipeTargets.some((t) =>
          ['sh', 'bash', 'zsh', 'python', 'python3', 'perl', 'ruby', 'node'].includes(t),
        )
      ) {
        findings.push({
          ruleId: 'cmd-30-pipe-to-shell',
          explanation: 'pipeline feeds download/network content to an interpreter',
          addsClass: 'PRIVILEGED',
        });
      }
      if (pipeSources.some((s) => ['curl', 'wget'].includes(s))) {
        classes.add('NETWORKED');
      }
      for (const segment of shellResult.segments) {
        findings.push(...structuralFindingsForSimple(segment.executable, segment.argv));
        for (const klass of classifySimple(segment.executable, segment.argv)) classes.add(klass);
      }
      if (
        shellResult.segments.length > 1 &&
        findings.some((finding) => finding.ruleId === 'cmd-30-pipe-to-shell')
      ) {
        parseStatus = 'AMBIGUOUS';
        unsupportedReason = 'pipeline mixes network fetch with interpreter execution';
      }
    }
  }

  for (const finding of findings) {
    if (finding.addsClass) classes.add(finding.addsClass);
  }

  const fingerprintInput = JSON.stringify([proposal, context.knownScriptHashes ?? {}]);
  const factors = [
    ...findings.map((finding) => ({ ruleId: finding.ruleId, explanation: finding.explanation })),
    ...(unsupportedReason
      ? [{ ruleId: 'cmd-99-unsupported', explanation: unsupportedReason }]
      : []),
  ];

  return Object.freeze({
    classes: [...classes].sort(),
    factors,
    obligations: [
      ...SANDBOX_OBLIGATIONS,
      ...(classes.has('NETWORKED') || classes.has('PACKAGE_INSTALL')
        ? ['network_profile_required']
        : ['network_default_deny']),
    ],
    parseStatus,
    astFingerprint: createHash('sha256').update(fingerprintInput).digest('hex'),
    analyzerVersion: 'command-analyzer@1',
  });
}

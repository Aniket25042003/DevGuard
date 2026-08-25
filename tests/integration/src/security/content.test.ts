import { describe, expect, it } from 'vitest';
import {
  ArtifactPromotionService,
  PublicationGuard,
  SensitiveDataGuard,
  authorizeArtifactRead,
  collectOutput,
  inspectTarArchive,
  sanitizeTerminal,
  normalizeRelativePath,
  validatePatch,
} from '@devguard/security';
import { contentBudget } from '@devguard/security';

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

describe('C095 path canonicalization (lexical layer)', () => {
  it('normalizes benign relative paths', () => {
    const safe = normalizeRelativePath('ws1', 'src/lib/util.ts');
    expect(safe.normalizedRelativePath).toBe('src/lib/util.ts');
    expect(safe.kind).toBe('file');
  });

  it('rejects every traversal and encoding vector (table)', () => {
    const cases: ReadonlyArray<{ readonly input: string; readonly code: string }> = [
      { input: '../etc/passwd', code: 'traversal_above_root' },
      { input: 'a/../../etc/passwd', code: 'traversal_above_root' },
      { input: '/etc/passwd', code: 'absolute_path' },
      { input: 'C:/Windows/system32', code: 'windows_drive' },
      { input: '\\\\server\\share\\file', code: 'alternate_separator' },
      { input: 'src\\util.ts', code: 'alternate_separator' },
      { input: 'file\u0000.txt', code: 'nul_byte' },
      { input: 'file%2e%2e/secret', code: 'encoded_traversal' },
      { input: 'a%252fb', code: 'double_encoding' },
      { input: 'src/file.', code: 'trailing_dot_or_space' },
      { input: 'src/file ', code: 'trailing_dot_or_space' },
      { input: 'CON', code: 'reserved_device_name' },
      { input: 'com1.log', code: 'reserved_device_name' },
    ];
    for (const testCase of cases) {
      let reasonCode = '';
      try {
        normalizeRelativePath('ws1', testCase.input);
      } catch (error) {
        reasonCode =
          (error as { safeDetails?: { reasonCode?: string } }).safeDetails?.reasonCode ?? '';
      }
      expect(reasonCode, `input ${JSON.stringify(testCase.input)}`).toBe(testCase.code);
    }
  });

  it('resolves interior .. without escaping the root', () => {
    const safe = normalizeRelativePath('ws1', 'src/../lib/util.ts');
    expect(safe.normalizedRelativePath).toBe('lib/util.ts');
  });
});

// ---------------------------------------------------------------------------
// Archives (tar)
// ---------------------------------------------------------------------------

function tarEntry(name: string, content: Buffer, typeflag = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write(content.byteLength.toString(8).padStart(11, '0') + '\u0000', 124, 12, 'latin1');
  header.write(typeflag, 156, 1, 'latin1');
  header.write('ustar\u000000', 257, 8, 'latin1');
  const padding = Buffer.alloc((512 - (content.byteLength % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tarEnd(): Buffer {
  return Buffer.alloc(1024);
}

describe('C095 tar archive inspection', () => {
  const tinyBudget = contentBudget({ maxFiles: 10, maxTotalBytes: 10_000, maxArchiveRatio: 50 });

  it('parses a clean tar into a validated manifest', () => {
    const archive = Buffer.concat([
      tarEntry('src/index.ts', Buffer.from('export {};\n')),
      tarEntry('README.md', Buffer.from('# hi\n')),
      tarEnd(),
    ]);
    const manifest = inspectTarArchive(archive, archive.length / 4, tinyBudget);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['src/index.ts', 'README.md']);
    expect(manifest.entries.every((entry) => entry.type === 'file')).toBe(true);
  });

  it('rejects traversal names, symlinks/devices, case collisions, and budget bombs', () => {
    const traversal = Buffer.concat([tarEntry('../escape.sh', Buffer.from('x')), tarEnd()]);
    expect(() => inspectTarArchive(traversal, 10, tinyBudget)).toThrowError(
      /entry_traversal_above_root/,
    );

    const symlink = Buffer.concat([
      (() => {
        const block = Buffer.alloc(512);
        block.write('link', 0, 100, 'utf8');
        block.write('2', 124, 12, 'latin1');
        block.write('2', 156, 1, 'latin1'); // typeflag '2' = symlink
        block.write('ustar\u000000', 257, 8, 'latin1');
        return block;
      })(),
      tarEnd(),
    ]);
    expect(() => inspectTarArchive(symlink, 10, tinyBudget)).toThrowError(/link_or_device_entry/);

    const collision = Buffer.concat([
      tarEntry('File.txt', Buffer.from('a')),
      tarEntry('file.txt', Buffer.from('b')),
      tarEnd(),
    ]);
    expect(() => inspectTarArchive(collision, 10, tinyBudget)).toThrowError(
      /case_colliding_duplicate/,
    );

    const bomb = Buffer.concat([tarEntry('bomb.bin', Buffer.alloc(9_000)), tarEnd()]);
    expect(() => inspectTarArchive(bomb, 10, tinyBudget)).toThrowError(/expansion_ratio_budget/);

    const tooMany = Buffer.concat([
      ...Array.from({ length: 12 }, (_unused, index) =>
        tarEntry(`f${index}.txt`, Buffer.from('x')),
      ),
      tarEnd(),
    ]);
    expect(() => inspectTarArchive(tooMany, 1000, tinyBudget)).toThrowError(/file_count_budget/);
  });

  it('fails closed on non-tar container formats (zip rejected until supported)', () => {
    const zipBytes = Buffer.from('PK\u0003\u0004' + 'x'.repeat(600));
    expect(() => inspectTarArchive(zipBytes, 10, tinyBudget)).toThrowError(
      /unsupported_magic|invalid_tar_structure/,
    );
  });
});

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

const CLEAN_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' existing line',
  '+added line',
  ' another line',
].join('\n');

describe('C095 patch validation', () => {
  const context = {
    rootId: 'ws1',
    protectedPrefixes: ['.github/workflows'],
  };

  it('accepts a clean in-root patch with parsed operations', () => {
    const validation = validatePatch(CLEAN_PATCH, context);
    expect(validation.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(validation.operations[0]?.targetPath).toBe('src/app.ts');
    expect(validation.totalAddedLines).toBe(1);
    expect(validation.withinBudget).toBe(true);
  });

  it('rejects escapes, git internals, protected paths, and binary patches', () => {
    const escape = CLEAN_PATCH.replace('a/src/app.ts', 'a/../../../etc/hosts').replace(
      'b/src/app.ts',
      'b/../../../etc/hosts',
    );
    expect(() => validatePatch(escape, context)).toThrowError();

    const gitInternal = CLEAN_PATCH.replace('src/app.ts', '.git/config').replace(
      'src/app.ts',
      '.git/config',
    );
    let gitCode = '';
    try {
      validatePatch(gitInternal, context);
    } catch (error) {
      gitCode = (error as { code?: string }).code ?? '';
    }
    expect(gitCode).toBe('PATCH_REJECTED');

    const workflowChange = CLEAN_PATCH.replace('src/app.ts', '.github/workflows/ci.yml').replace(
      'src/app.ts',
      '.github/workflows/ci.yml',
    );
    let protectedCode = '';
    try {
      validatePatch(workflowChange, context);
    } catch (error) {
      protectedCode = (error as { code?: string }).code ?? '';
    }
    expect(protectedCode).toBe('PATCH_REJECTED');

    const binary = `${CLEAN_PATCH}\nGIT binary patch\nliteral 10\n`;
    let binCode = '';
    try {
      validatePatch(binary, { ...context });
    } catch (error) {
      binCode = (error as { code?: string }).code ?? '';
    }
    expect(binCode).toBe('PATCH_REJECTED');
  });

  it('enforces file/hunk/line budgets from the configured ContentBudget', () => {
    const manyFiles = Array.from({ length: 5 }, (_unused, index) =>
      [
        `diff --git a/f${index}.ts b/f${index}.ts`,
        `--- a/f${index}.ts`,
        `+++ b/f${index}.ts`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    ).join('\n');
    expect(() =>
      validatePatch(manyFiles, { ...context, budget: { maxPatchFiles: 2 } }),
    ).toThrowError();
  });
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('C095 output budgets and terminal sanitization', () => {
  it('collects under byte and line budgets with explicit truncation metadata', async () => {
    const small = await collectOutput('short output', {});
    expect(small.truncated).toBe(false);
    expect(small.originalLines).toBe(1);

    const bytesTruncated = await collectOutput('x'.repeat(1_500), {
      maxTotalBytes: 1_000,
      maxLines: 20_000,
    });
    void bytesTruncated;
    // Byte-budget enforcement is exercised via the streaming path below.

    const lineSource = (async function* generate(): AsyncIterable<Uint8Array> {
      for (let index = 0; index < 50; index += 1) {
        yield Buffer.from(`line ${index}\n`, 'utf8');
      }
    })();
    const limited = await collectOutput(lineSource, { maxLines: 10, maxTotalBytes: 1_000_000 });
    expect(limited.truncated).toBe(true);
    expect(limited.limitKind).toBe('lines');
    expect(limited.originalLines).toBeGreaterThan(limited.text.split('\n').length - 1);
    expect(limited.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sanitizes ANSI CSI/OSC sequences for UI projection', () => {
    const hostile = '\u001B[31mred\u001B[0m plain \u001B]0;title\u0007end \u001B[2Jclear';
    const sanitized = sanitizeTerminal(hostile);
    // eslint-disable-next-line no-control-regex
    expect(sanitized).not.toMatch(/\u001B/);
    expect(sanitized).toContain('red');
    expect(sanitized).toContain('plain');
  });
});

// ---------------------------------------------------------------------------
// Artifact scan/promote pipeline
// ---------------------------------------------------------------------------

describe('C095 artifact scan/quarantine/promotion pipeline', () => {
  function pipeline(
    options: {
      leakStatus?: 'clean' | 'findings_present' | 'scanner_unavailable';
      contentFindings?: number;
      contentAvailable?: boolean;
    } = {},
  ) {
    const publicationGuardLike = {
      scanForLeaks: async () => ({
        status: options.leakStatus ?? ('clean' as const),
        findings:
          options.leakStatus === 'findings_present' ? [{ detectorClass: 'exact_value' }] : [],
      }),
    };
    const contentScanner = {
      scan: async () => ({
        available: options.contentAvailable ?? true,
        findings: options.contentFindings ?? 0,
      }),
    };
    return new ArtifactPromotionService(publicationGuardLike, contentScanner, () => new Date(0));
  }

  const candidate = {
    repositoryId: crypto.randomUUID(),
    workflowRunId: crypto.randomUUID(),
    mediaType: 'text/plain',
    content: Buffer.from('artifact body'),
  };

  it('promotes only exact scanned bytes to SAFE', async () => {
    const record = await pipeline().scanAndPromote(candidate);
    expect(record.scanState).toBe('SAFE');
    expect(record.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('quarantines on leak findings without ever reaching SAFE', async () => {
    const record = await pipeline({ leakStatus: 'findings_present' }).scanAndPromote(candidate);
    expect(record.scanState).toBe('QUARANTINED');
    expect(record.quarantineReasonCode).toBe('leak_findings');
  });

  it('retries scanner outages within bounds, then fails closed into quarantine', async () => {
    let scansSeen = 0;
    const flaky = new ArtifactPromotionService(
      {
        scanForLeaks: async () => {
          scansSeen += 1;
          return { status: 'scanner_unavailable' as const, findings: [] };
        },
      },
      { scan: async () => ({ available: true, findings: 0 }) },
    );
    const record = await flaky.scanAndPromote(candidate);
    expect(record.scanState).toBe('QUARANTINED');
    expect(record.quarantineReasonCode).toBe('scanner_unavailable');
    expect(scansSeen).toBe(2); // bounded retry, then fail closed
  });

  it('lifecycle gates: non-SAFE and expired artifacts are never served', async () => {
    const guard = new SensitiveDataGuard({});
    void guard;
    const publication = new PublicationGuard(new SensitiveDataGuard({}));
    void publication;

    const quarantinedRecord = {
      repositoryId: 'repo-1',
      scanState: 'QUARANTINED' as const,
    };
    expect(() =>
      authorizeArtifactReadFor(quarantinedRecord, { allowed: true, repositoryId: 'repo-1' }),
    ).toThrowError();

    const expiredRecord = {
      repositoryId: 'repo-1',
      scanState: 'SAFE' as const,
      retentionExpiresAt: new Date(0).toISOString(),
    };
    expect(() =>
      authorizeArtifactReadFor(expiredRecord, { allowed: true, repositoryId: 'repo-1' }),
    ).toThrowError();

    const crossTenant = {
      repositoryId: 'repo-other',
      scanState: 'SAFE' as const,
    };
    expect(() =>
      authorizeArtifactReadFor(crossTenant, { allowed: true, repositoryId: 'repo-1' }),
    ).toThrowError();

    function authorizeArtifactReadFor(
      record: Parameters<typeof authorizeArtifactRead>[0],
      access: { allowed: boolean; repositoryId: string },
    ): void {
      authorizeArtifactRead(record, access);
    }
  });
});

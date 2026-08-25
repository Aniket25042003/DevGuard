/**
 * C095 — Tar archive inspection and quarantine extraction.
 *
 * MVP format policy (ADR-0011): POSIX ustar/GNU-basic **tar** only. ZIP and
 * other container formats are REJECTED closed until dedicated parsers land.
 * Every entry is validated BEFORE any byte is extracted; cumulative budgets
 * are enforced while streaming; links/devices/FIFOs are rejected; duplicate
 * and case-colliding names are rejected.
 */
import { normalizeRelativePath } from './paths.js';
import type { ContentBudget } from './paths.js';

export interface ArchiveEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly type: 'file' | 'directory';
}

export interface ArchiveManifest {
  readonly entries: readonly ArchiveEntry[];
  readonly totalUncompressedBytes: number;
  readonly maxDepth: number;
  readonly expansionRatio: number;
  readonly compressedBytes: number;
}

export class ArchiveRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = 'ArchiveRejectedError';
    this.reasonCode = reasonCode;
  }
}

function reject(reasonCode: string): never {
  throw new ArchiveRejectedError(reasonCode, `archive rejected: ${reasonCode}`);
}

const TAR_BLOCK = 512;

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nulIndex = slice.indexOf(0);
  return slice.subarray(0, nulIndex === -1 ? length : nulIndex).toString('utf8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text.length === 0) return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

/**
 * Parse a tar byte stream into a validated manifest.
 * Supports ustar/GNU basic typeflags '0' (file), '\u0000' (legacy file), '5' (directory).
 */
export function inspectTarArchive(
  tarBytes: Buffer,
  compressedBytes: number,
  budget: ContentBudget,
): ArchiveManifest {
  if (tarBytes.length % TAR_BLOCK !== 0 || tarBytes.length < TAR_BLOCK) {
    reject('invalid_tar_structure');
  }
  const entries: ArchiveEntry[] = [];
  const seenNamesLower = new Set<string>();
  let offset = 0;
  let total = 0;
  let maxDepth = 0;

  while (offset + TAR_BLOCK <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK);
    const name = readString(header, 0, 100);
    if (name.length === 0) break; // two consecutive zero blocks end the archive
    const size = readOctal(header, 124, 12);
    const typeflagByte = header[156] ?? 0x30;
    const typeflag = String.fromCharCode(typeflagByte);
    const prefix = readString(header, 345, 155);
    const magic = readString(header, 257, 6);

    if (magic !== 'ustar\u0000' && !magic.startsWith('ustar')) {
      // GNU basic tars use 'ustar  \0' / 'ustar ' — accept those prefixes only.
      if (!magic.startsWith('ustar')) reject('unsupported_magic');
    }

    const fullRawName = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (typeflag === 'L' || typeflag === 'K' || typeflag === 'x' || typeflag === 'g') {
      // GNU long-name/PAX headers are not supported in the MVP parser.
      reject('pax_or_longname_unsupported');
    }
    if (!['0', '\u0000', '5'].includes(typeflag)) {
      reject('link_or_device_entry');
    }
    if (size < 0) reject('invalid_entry_size');

    // Path safety through the SAME PathGuard lexical rules.
    let safePath: string;
    try {
      safePath = normalizeRelativePath('archive', fullRawName).normalizedRelativePath;
    } catch (error) {
      const code =
        (error as { safeDetails?: { reasonCode?: string } }).safeDetails?.reasonCode ??
        'unsafe_path';
      reject(`entry_${code}`);
    }
    const lower = safePath.toLowerCase();
    if (seenNamesLower.has(lower)) reject('case_colliding_duplicate');
    seenNamesLower.add(lower);

    const entryType = typeflag === '5' ? 'directory' : 'file';
    if (entryType === 'file' && size > budget.maxFileBytes) reject('file_bytes_budget');
    entries.push({
      path: safePath,
      sizeBytes: entryType === 'directory' ? 0 : size,
      type: entryType,
    });
    total += entryType === 'directory' ? 0 : size;
    maxDepth = Math.max(maxDepth, safePath.split('/').length);
    if (total > budget.maxTotalBytes) reject('total_bytes_budget');
    if (entries.length > budget.maxFiles) reject('file_count_budget');
    if (maxDepth > budget.maxDepth) reject('depth_budget');

    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  if (entries.length === 0) reject('empty_archive');
  const ratio = compressedBytes > 0 ? total / compressedBytes : total;
  if (compressedBytes > 0 && ratio > budget.maxArchiveRatio) reject('expansion_ratio_budget');

  return {
    entries,
    totalUncompressedBytes: total,
    maxDepth,
    expansionRatio: Math.round(ratio),
    compressedBytes,
  };
}

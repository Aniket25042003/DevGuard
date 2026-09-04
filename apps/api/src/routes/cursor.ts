import { validationFailed } from '@devguard/errors';

export interface ResourceCursor {
  readonly createdAtIso: string;
  readonly id: string;
}

/**
 * Versioned opaque cursor shared by every keyset-paginated API route.
 * The version is part of the payload so future codecs can reject old formats
 * deterministically instead of silently changing pagination semantics.
 */
export function encodeResourceCursor(value: ResourceCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
}

export function parseResourceCursor(value: string): ResourceCursor {
  try {
    // base64url decoding is deliberately strict enough for our wire format:
    // re-encoding prevents accepting arbitrary padded/alternate encodings.
    if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding');
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      v?: unknown;
      createdAtIso?: unknown;
      id?: unknown;
    };
    if (
      decoded.v !== 1 ||
      typeof decoded.createdAtIso !== 'string' ||
      decoded.createdAtIso.length === 0 ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0
    ) {
      throw new Error('shape');
    }
    return { createdAtIso: decoded.createdAtIso, id: decoded.id };
  } catch {
    throw validationFailed([{ path: 'cursor', constraint: 'invalid_cursor' }]);
  }
}

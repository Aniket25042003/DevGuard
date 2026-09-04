/**
 * CP012 (C012/C044) — artifact ObjectStore (local disk backend).
 *
 * Object keys are ALWAYS the caller-supplied uuid (never a user-supplied path);
 * path traversal and secrets are rejected before any bytes hit disk. `put`
 * returns a sha256 checksum; a metadata failure expects the caller to issue a
 * compensating `delete`. S3-compatible backends can replace this behind the
 * same `ObjectStore` port.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, lstat, open, link, unlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

/** Typed, transport-mappable storage error (CP012 §23). */
export class ArtifactStorageError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'ArtifactStorageError';
    this.code = code;
  }
}

export interface ObjectStoreResult {
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ObjectStore {
  put(
    objectKey: string,
    bytes: Uint8Array,
    contentType?: string | undefined,
  ): Promise<ObjectStoreResult>;
  get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string | undefined } | null>;
  delete(objectKey: string): Promise<boolean>;
}

export const OBJECT_KEY_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Rejects obvious secret-bearing payloads before they are persisted (C093). */
const SECRET_PATTERNS = [
  /(?:password|passwd|api[_-]?key|secret|token|authorization)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i,
];
const containsSecret = (text: string): boolean =>
  SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private resolveKey(objectKey: string): string {
    if (!OBJECT_KEY_PATTERN.test(objectKey)) {
      throw new ArtifactStorageError('OBJECT_KEY_INVALID', 'object key must be a UUID');
    }
    const full = resolve(this.root, objectKey);
    if (
      relative(this.root, full) === '' ||
      relative(this.root, full).startsWith('..' + sep) ||
      relative(this.root, full) === '..'
    ) {
      throw new ArtifactStorageError('OBJECT_KEY_PATH_TRAVERSAL', 'path traversal rejected');
    }
    return full;
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<ObjectStoreResult> {
    const text = Buffer.from(bytes).toString('utf8');
    if (containsSecret(text)) {
      throw new ArtifactStorageError(
        'ARTIFACT_CONTAINS_SECRET',
        'secret-bearing artifact rejected',
      );
    }
    await mkdir(this.root, { recursive: true });
    const full = this.resolveKey(objectKey);
    const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await link(temp, full);
    } finally {
      await handle.close();
      await unlink(temp).catch(() => undefined);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { objectKey, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(
    objectKey: string,
  ): Promise<{ bytes: Uint8Array; contentType?: string | undefined } | null> {
    const full = this.resolveKey(objectKey);
    try {
      const info = await lstat(full);
      if (!info.isFile())
        throw new ArtifactStorageError('OBJECT_TYPE_INVALID', 'object is not a regular file');
      const bytes = await readFile(full);
      return { bytes: new Uint8Array(bytes) };
    } catch (error) {
      if (error instanceof Object && (error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<boolean> {
    const full = this.resolveKey(objectKey);
    try {
      await rm(full, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(objectKey: string): Promise<number | null> {
    const full = this.resolveKey(objectKey);
    try {
      const s = await stat(full);
      return s.size;
    } catch {
      return null;
    }
  }
}

/**
 * Durable S3-compatible implementation used by API and workers in
 * production. Keys remain UUIDs, writes are content-addressed by checksum,
 * and all provider errors are mapped to the storage boundary.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix = 'devguard/artifacts',
    config: S3ClientConfig = {},
  ) {
    if (bucket.trim().length === 0) throw new ArtifactStorageError('BUCKET_REQUIRED');
    this.client = new S3Client(config);
  }

  private key(objectKey: string): string {
    if (!OBJECT_KEY_PATTERN.test(objectKey)) {
      throw new ArtifactStorageError('OBJECT_KEY_INVALID', 'object key must be a UUID');
    }
    return `${this.prefix.replace(/\/$/, '')}/${objectKey}`;
  }

  async put(objectKey: string, bytes: Uint8Array, contentType?: string): Promise<ObjectStoreResult> {
    const text = Buffer.from(bytes).toString('utf8');
    if (containsSecret(text)) throw new ArtifactStorageError('ARTIFACT_CONTAINS_SECRET');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(objectKey),
          Body: bytes,
          ContentType: contentType,
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          Metadata: { sha256 },
        }),
      );
      return { objectKey, sizeBytes: bytes.byteLength, sha256 };
    } catch (error) {
      throw new ArtifactStorageError('OBJECT_PUT_FAILED', String(error));
    }
  }

  async get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(objectKey) }),
      );
      if (response.Body === undefined) return null;
      const bytes = await response.Body.transformToByteArray();
      const expected = response.Metadata?.['sha256'];
      if (expected !== undefined && createHash('sha256').update(bytes).digest('hex') !== expected) {
        throw new ArtifactStorageError('OBJECT_CHECKSUM_MISMATCH');
      }
      return { bytes, ...(response.ContentType !== undefined ? { contentType: response.ContentType } : {}) };
    } catch (error) {
      if (error instanceof ArtifactStorageError) throw error;
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw new ArtifactStorageError('OBJECT_GET_FAILED', String(error));
    }
  }

  async delete(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(objectKey) }));
      return true;
    } catch {
      return false;
    }
  }
}

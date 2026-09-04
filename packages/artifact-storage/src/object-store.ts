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
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
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
  probe?(): Promise<boolean>;
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

/** S3-compatible durable object store used by production API and workers. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: {
      readonly endpoint: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly region?: string;
    },
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(
    objectKey: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<ObjectStoreResult> {
    validateObjectKey(objectKey);
    const text = Buffer.from(bytes).toString('utf8');
    if (containsSecret(text)) throw new ArtifactStorageError('ARTIFACT_CONTAINS_SECRET');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: contentType ?? 'application/octet-stream',
        Metadata: { sha256 },
      }),
    );
    return { objectKey, sizeBytes: bytes.byteLength, sha256 };
  }

  async get(objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    validateObjectKey(objectKey);
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (output.Body === undefined) return null;
      const chunks: Uint8Array[] = [];
      for await (const chunk of output.Body as AsyncIterable<Uint8Array | string>) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      return {
        bytes: new Uint8Array(bytes),
        ...(output.ContentType ? { contentType: output.ContentType } : {}),
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<boolean> {
    validateObjectKey(objectKey);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return true;
  }

  async probe(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

function validateObjectKey(objectKey: string): void {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    throw new ArtifactStorageError('OBJECT_KEY_INVALID', 'object key must be a UUID');
  }
}

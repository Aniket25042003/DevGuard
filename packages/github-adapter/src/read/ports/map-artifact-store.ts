/**
 * C015 §13 — map artifact writer port (checksummed object storage boundary).
 *
 * Large/raw content is stored as checksummed artifacts and referenced, never
 * embedded in map facts (C015 §8/§13). A real object-storage implementation
 * is deferred; the in-memory fake supports deterministic unit tests.
 */
import { createHash } from 'node:crypto';

export interface MapArtifactRef {
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export interface MapArtifactStorePort {
  writeBlob(content: string): Promise<MapArtifactRef>;
  readBlob(artifactRef: string): Promise<{ content: string; contentHash: string } | undefined>;
}

/** Deterministic in-memory artifact store keyed by content hash. */
export class InMemoryMapArtifactStore implements MapArtifactStorePort {
  readonly blobs = new Map<string, string>();

  async writeBlob(content: string): Promise<MapArtifactRef> {
    const contentHash = createHash('sha256').update(content).digest('hex');
    this.blobs.set(contentHash, content);
    return {
      artifactRef: `artifact:${contentHash}`,
      contentHash,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  async readBlob(
    artifactRef: string,
  ): Promise<{ content: string; contentHash: string } | undefined> {
    const contentHash = artifactRef.replace(/^artifact:/, '');
    const content = this.blobs.get(contentHash);
    return content === undefined ? undefined : { content, contentHash };
  }
}

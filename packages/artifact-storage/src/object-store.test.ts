/** CP012 — LocalObjectStore: round-trip, path traversal, secret rejection. */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ArtifactStorageError, LocalObjectStore } from './object-store.js';

const KEY = 'c8a2e9f0-1111-4222-8333-444455556666';

describe('LocalObjectStore (CP012)', () => {
  it('put/get/delete round-trips bytes and returns a sha256', async () => {
    const dir = join(tmpdir(), `dg-art-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const store = new LocalObjectStore(dir);
    const bytes = Buffer.from('hello artifact', 'utf8');
    const result = await store.put(KEY, new Uint8Array(bytes));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const got = await store.get(KEY);
    expect(got).not.toBeNull();
    expect(Buffer.from(got!.bytes).toString('utf8')).toBe('hello artifact');
    expect(await store.delete(KEY)).toBe(true);
    expect(await store.get(KEY)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects path traversal via the object key', async () => {
    const store = new LocalObjectStore(join(tmpdir(), 'dg-trav'));
    await expect(store.put('../escape', new Uint8Array(0))).rejects.toThrow(ArtifactStorageError);
    await expect(store.get('../escape')).rejects.toThrow(ArtifactStorageError);
  });

  it('rejects secret-bearing artifact bytes before persisting (C093)', async () => {
    const store = new LocalObjectStore(join(tmpdir(), 'dg-secret'));
    const leak = Buffer.from('password=superSecretValue123', 'utf8');
    await expect(store.put(KEY, new Uint8Array(leak))).rejects.toMatchObject({
      code: 'ARTIFACT_CONTAINS_SECRET',
    });
  });
});

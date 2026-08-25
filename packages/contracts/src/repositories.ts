/**
 * C004 — Repository and identity contracts.
 *
 * GitHub stays authoritative for repository state; DevGuard persists
 * normalized projections with lifecycle status. Installation selection is a
 * separate concept from user identity.
 */
import { z } from 'zod';
import { externalRefSchema, provenance, ProvenanceSource } from './context.js';
import type { ExternalRefShape, ProvenanceShape } from './context.js';
import { rowVersion, schemas, timestampIso } from './primitives.js';

export const RepositoryLifecycleStatus = z.enum(['pending', 'active', 'degraded', 'disconnected']);
export type RepositoryLifecycleStatus = z.infer<typeof RepositoryLifecycleStatus>;

export interface ConnectedRepositoryShape {
  readonly id: string;
  readonly installationRef: string;
  readonly owner: string;
  readonly name: string;
  /** `owner/name` convenience projection; validated for shape. */
  readonly fullName: string;
  readonly defaultBranch?: string | undefined;
  readonly status: RepositoryLifecycleStatus;
  readonly externalRef: ExternalRefShape;
  readonly metadataProvenance?: ProvenanceShape | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

const repoNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

export const connectedRepository: z.ZodType<ConnectedRepositoryShape> = z
  .object({
    id: schemas.repositoryId,
    installationRef: z.string().min(1).max(128),
    owner: z.string().regex(repoNamePattern),
    name: z.string().regex(repoNamePattern),
    fullName: z.string().max(201),
    defaultBranch: z.string().max(256).optional(),
    status: RepositoryLifecycleStatus,
    externalRef: externalRefSchema,
    metadataProvenance: provenance.optional(),
    createdAt: timestampIso,
    updatedAt: timestampIso,
    rowVersion: rowVersion,
  })
  .strip()
  .refine((value) => value.fullName === `${value.owner}/${value.name}`, {
    message: 'fullName must equal owner/name',
    path: ['fullName'],
  });

/** Identity principal used by authorization (C005/C006 refine behavior). */
export interface UserPrincipalShape {
  readonly userId: string;
  readonly authKind: 'github_oauth' | 'none_dev';
  readonly displayName?: string | undefined;
}

export const userPrincipal: z.ZodType<UserPrincipalShape> = z
  .object({
    userId: schemas.userId,
    authKind: z.enum(['github_oauth', 'none_dev']),
    displayName: z.string().max(256).optional(),
  })
  .strip();

export { ProvenanceSource };

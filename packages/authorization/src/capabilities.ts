/**
 * C006 — Repository authorization: capability catalog and contracts.
 *
 * Every repository-scoped use case declares exactly ONE capability here.
 * Decisions are immutable; evidence expires. Default deny on ambiguity,
 * provider outage, disconnected repository, or unknown capability.
 */
import { z } from 'zod';
import { timestampIso } from '@devguard/contracts';

export const RepositoryCapability = z.enum([
  'repository:read',
  'repository:connect',
  'policy:read',
  'policy:write',
  'workflow:start',
  'workflow:cancel',
  'approval:resolve',
  'artifact:read',
  'repository:privileged_action',
]);
export type RepositoryCapability = z.infer<typeof RepositoryCapability>;

/** Capabilities whose checks can NEVER be served from cache (IF-2/§17). */
const FRESH_REQUIRED: ReadonlySet<RepositoryCapability> = new Set([
  'policy:write',
  'approval:resolve',
  'repository:privileged_action',
  'workflow:cancel',
  // Connect-time authority must always revalidate the provider — a cached
  // admin allow from earlier must never authorize a new connection.
  'repository:connect',
]);

export function requiresFreshCheck(capability: RepositoryCapability): boolean {
  return FRESH_REQUIRED.has(capability);
}

export type PrincipalRef =
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly issuer: string;
      readonly providerSubject: string;
    }
  | {
      readonly kind: 'system';
      /** Bounded service identity, e.g. 'worker.approval-resume'. */
      readonly serviceId: string;
      /** The persisted command/run the actor executes on behalf of. */
      readonly binding: {
        readonly workflowRunId?: string | undefined;
        readonly approvalId?: string | undefined;
      };
    };

export interface AuthorizationQueryShape {
  readonly principal: PrincipalRef;
  readonly repositoryId: string;
  readonly capability: RepositoryCapability;
  readonly context?:
    | {
        readonly workflowRunId?: string | undefined;
        readonly approvalId?: string | undefined;
        readonly targetExternalId?: string | undefined;
      }
    | undefined;
}

export const authorizationQuery: z.ZodType<AuthorizationQueryShape> = z
  .object({
    principal: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('user'),
          userId: z.string().min(1).max(128),
          issuer: z.string().min(1).max(128),
          providerSubject: z.string().min(1).max(128),
        })
        .strip(),
      z
        .object({
          kind: z.literal('system'),
          serviceId: z.string().regex(/^[a-z][a-z0-9.-]{2,64}$/),
          binding: z
            .object({
              workflowRunId: z.string().min(1).max(128).optional(),
              approvalId: z.string().min(1).max(128).optional(),
            })
            .strip(),
        })
        .strip(),
    ]),
    repositoryId: z.string().min(1).max(128),
    capability: RepositoryCapability,
    context: z
      .object({
        workflowRunId: z.string().min(1).max(128).optional(),
        approvalId: z.string().min(1).max(128).optional(),
        targetExternalId: z.string().min(1).max(128).optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

export interface AuthorizationDecisionShape {
  readonly effect: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly evidenceId?: string | undefined;
  readonly checkedAt: ReturnType<typeof timestampIso.parse>;
  readonly expiresAt?: ReturnType<typeof timestampIso.parse> | undefined;
}

export type AuthorizationSource = 'local' | 'github' | 'cache';

export interface AuthorizationEvidenceRecord {
  readonly id: string;
  readonly repositoryId: string;
  readonly subjectKey: string;
  readonly capability: RepositoryCapability;
  readonly effect: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly source: AuthorizationSource;
  /** Digest over the provider permission snapshot backing this evidence. */
  readonly providerSnapshotHash?: string | undefined;
  readonly checkedAt: string;
  readonly expiresAt?: string | undefined;
}

/** Local linkage port: DevGuard's own record of installation/repository wiring. */
export interface LocalRepositoryAccessPort {
  /** Returns linkage or undefined when the repository is unknown locally. */
  findLinkage(repositoryId: string): Promise<
    | {
        readonly status: 'pending' | 'active' | 'degraded' | 'disconnected';
        readonly installationRef: string;
      }
    | undefined
  >;
  /** Whether this user is recorded as the connecting owner. */
  isConnectingOwner(repositoryId: string, userId: string): Promise<boolean>;
}

/**
 * GitHub-authoritative permission port. Roles normalize to a small set so
 * capability mapping stays deterministic across GitHub API changes.
 */
export type NormalizedGitHubRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface GitHubPermissionPort {
  fetchUserRole(input: {
    readonly installationRef: string;
    readonly repositoryExternalIdHint?: string | undefined;
    readonly providerSubject: string;
  }): Promise<{ role: NormalizedGitHubRole; snapshotHash: string }>;
}

/** Evidence append/lookup port (PostgreSQL adapter arrives with C007/C009). */
export interface AuthorizationEvidencePort {
  append(record: AuthorizationEvidenceRecord): Promise<void>;
  findFresh(
    subjectKey: string,
    repositoryId: string,
    capability: RepositoryCapability,
    nowMs: number,
  ): Promise<AuthorizationEvidenceRecord | undefined>;
}

export { timestampIso };

/**
 * C006 — RepositoryAuthorizationService.
 *
 * Order of authority (fail closed at every step):
 *   1. Local linkage must exist and be active/degraded (not disconnected).
 *   2. User principals map through GitHub-authoritative roles; system actors
 *      are bound to a persisted run/approval scope and never forge users.
 *   3. Fresh checks are MANDATORY for privileged capabilities; reads may use
 *      short-TTL evidence.
 * Denials never distinguish "missing repository" from "no access".
 */
import { makeError, repositoryForbidden } from '@devguard/errors';
import {
  authorizationQuery,
  requiresFreshCheck,
  type AuthorizationEvidencePort,
  type AuthorizationEvidenceRecord,
  type AuthorizationQueryShape,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
  type NormalizedGitHubRole,
  type PrincipalRef,
} from './capabilities.js';

export interface AuthorizationServiceDeps {
  readonly local: LocalRepositoryAccessPort;
  readonly github: GitHubPermissionPort;
  readonly evidence: AuthorizationEvidencePort;
  /** TTL for cacheable read evidence. Privileged checks ignore it. */
  readonly readCacheTtlSeconds: number;
  readonly now: () => Date;
}

export interface AuthorizeOptions {
  readonly freshness?: 'cached' | 'fresh';
}

export interface AuthorizationResult {
  readonly effect: 'allow' | 'deny';
  readonly reasonCode: string;
  readonly evidenceId?: string | undefined;
}

/** Deterministic role→capability floor per capability (ADR-0010). */
const ROLE_FLOOR: Readonly<Record<string, readonly NormalizedGitHubRole[]>> = {
  'repository:read': ['read', 'triage', 'write', 'maintain', 'admin'],
  'artifact:read': ['triage', 'write', 'maintain', 'admin'],
  'policy:read': ['triage', 'write', 'maintain', 'admin'],
  'workflow:start': ['write', 'maintain', 'admin'],
  'workflow:cancel': ['write', 'maintain', 'admin'],
  'policy:write': ['maintain', 'admin'],
  'approval:resolve': ['maintain', 'admin'],
  'repository:privileged_action': ['maintain', 'admin'],
  'repository:connect': ['admin'],
};

function roleSatisfies(role: NormalizedGitHubRole, capability: string): boolean {
  const allowed = ROLE_FLOOR[capability];
  return allowed !== undefined && allowed.includes(role);
}

function subjectKeyOf(principal: PrincipalRef): string {
  return principal.kind === 'user'
    ? `user:${principal.providerSubject}`
    : `system:${principal.serviceId}`;
}

export class RepositoryAuthorizationService {
  constructor(private readonly deps: AuthorizationServiceDeps) {}

  async authorize(
    query: AuthorizationQueryShape,
    options: AuthorizeOptions = {},
  ): Promise<AuthorizationResult> {
    const parsed = authorizationQuery.safeParse(query);
    if (!parsed.success) {
      // Unknown/malformed queries deny without echoing internals.
      return this.deny(query, 'malformed_query');
    }
    const q = parsed.data;

    // 1) System actors derive rights from their persisted binding; they still
    //    must pass the local linkage gate below (the repository must exist).
    let systemResult: AuthorizationResult | undefined;
    if (q.principal.kind === 'system') {
      systemResult = this.authorizeSystemActor(q);
      if (systemResult.effect === 'deny') {
        return systemResult;
      }
    }

    // 2) Local linkage gate.
    const linkage = await this.deps.local.findLinkage(q.repositoryId);
    if (linkage === undefined || linkage.status === 'disconnected') {
      // Non-enumerating: same public error whether missing or forbidden.
      throw repositoryForbidden(new Error('no_linkage'));
    }
    if (linkage.status === 'pending') {
      return this.deny(q, 'linkage_pending');
    }

    // System actors stop here: binding-scoped allowance is sufficient and no
    // provider role lookup applies to service identities.
    if (systemResult !== undefined) {
      await this.deps.evidence.append({
        id: crypto.randomUUID(),
        repositoryId: q.repositoryId,
        subjectKey: subjectKeyOf(q.principal),
        capability: q.capability,
        effect: 'allow',
        reasonCode: systemResult.reasonCode,
        source: 'local',
        checkedAt: this.deps.now().toISOString(),
      });
      return systemResult;
    }

    // 3) GitHub remains authoritative even for connecting owners.

    const fresh = options.freshness === 'fresh' || requiresFreshCheck(q.capability);
    const nowMs = this.deps.now().getTime();

    if (!fresh) {
      const cached = await this.deps.evidence.findFresh(
        subjectKeyOf(q.principal),
        q.repositoryId,
        q.capability,
        nowMs,
      );
      if (cached !== undefined) {
        return { effect: cached.effect, reasonCode: cached.reasonCode, evidenceId: cached.id };
      }
    }

    // Narrow to user principals: system actors already returned above.
    if (q.principal.kind !== 'user') {
      return this.deny(q, 'unexpected_actor');
    }

    let role: NormalizedGitHubRole;
    let snapshotHash: string | undefined;
    try {
      const fetched = await this.deps.github.fetchUserRole({
        installationRef: linkage.installationRef,
        providerSubject: q.principal.providerSubject,
      });
      role = fetched.role;
      snapshotHash = fetched.snapshotHash;
    } catch (error) {
      // Provider outage fails closed; privileged work cannot proceed on hope.
      void error;
      throw makeError('DEPENDENCY_UNAVAILABLE', {
        cause: new Error('permission_provider_unavailable'),
      });
    }

    const allowed = roleSatisfies(role, q.capability);
    const checkedAt = this.deps.now();
    const evidence: AuthorizationEvidenceRecord = {
      id: crypto.randomUUID(),
      repositoryId: q.repositoryId,
      subjectKey: subjectKeyOf(q.principal),
      capability: q.capability,
      effect: allowed ? 'allow' : 'deny',
      reasonCode: allowed ? 'role_satisfies_floor' : 'role_below_floor',
      source: 'github',
      ...(snapshotHash !== undefined ? { providerSnapshotHash: snapshotHash } : {}),
      checkedAt: checkedAt.toISOString(),
      ...(allowed && !requiresFreshCheck(q.capability)
        ? {
            expiresAt: new Date(
              checkedAt.getTime() + this.deps.readCacheTtlSeconds * 1_000,
            ).toISOString(),
          }
        : {}),
    };
    await this.deps.evidence.append(evidence);

    if (!allowed) {
      return this.deny(q, 'role_below_floor');
    }
    return {
      effect: 'allow',
      reasonCode: evidence.reasonCode,
      evidenceId: evidence.id,
    };
  }

  private authorizeSystemActor(q: AuthorizationQueryShape): AuthorizationResult {
    const principal = q.principal as Extract<
      AuthorizationQueryShape['principal'],
      { kind: 'system' }
    >;
    // System actors may drive workflow/approval machinery only within their
    // persisted binding; they can never grant user-facing capabilities.
    const systemAllowed = new Set(['workflow:start', 'workflow:cancel', 'approval:resolve']);
    if (!systemAllowed.has(q.capability)) {
      return this.deny(q, 'system_actor_capability_forbidden');
    }
    const binding = principal.binding ?? {};
    // Caller-provided IDs are references, NOT authorization evidence: the
    // requested operation context must be PRESENT and EQUAL the persisted
    // binding for both run-scoped and approval-scoped capabilities.
    const needsRunContext = q.capability === 'workflow:start' || q.capability === 'workflow:cancel';
    const needsApprovalContext = q.capability === 'approval:resolve';

    if (needsRunContext || needsApprovalContext) {
      if (q.context === undefined) {
        return this.deny(q, 'system_actor_missing_operation_context');
      }
      if (needsRunContext) {
        if (binding.workflowRunId === undefined) {
          return this.deny(q, 'system_actor_missing_run_binding');
        }
        if (q.context.workflowRunId === undefined) {
          return this.deny(q, 'system_actor_missing_run_context');
        }
        if (binding.workflowRunId !== q.context.workflowRunId) {
          return this.deny(q, 'system_actor_binding_mismatch');
        }
      }
      if (needsApprovalContext) {
        if (binding.approvalId === undefined) {
          return this.deny(q, 'system_actor_missing_approval_binding');
        }
        if (q.context.approvalId === undefined) {
          return this.deny(q, 'system_actor_missing_approval_context');
        }
        if (binding.approvalId !== q.context.approvalId) {
          return this.deny(q, 'system_actor_binding_mismatch');
        }
      }
    }
    return { effect: 'allow', reasonCode: 'system_actor_scoped' };
  }

  /** Stable non-enumerating denial: routes map deny→403 or deliberate 404. */
  private deny(q: AuthorizationQueryShape, reasonCode: string): AuthorizationResult {
    void q;
    return { effect: 'deny', reasonCode };
  }
}

export function requireAllow(result: AuthorizationResult, requestId: string): void {
  if (result.effect !== 'allow') {
    throw repositoryForbidden(new Error(`${result.reasonCode}:${requestId}`));
  }
}

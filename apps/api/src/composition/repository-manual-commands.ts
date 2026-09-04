/**
 * Resolve manual commands allowed for a repository from active policy.
 */
import { PolicyVersionStore } from '@devguard/db';
import { repositoryPolicyV1, type RepositoryPolicyV1 } from '@devguard/policy-engine';
import type { DevGuardPool } from '@devguard/db';

const DEFAULT_MANUAL_COMMANDS = [
  'review_remediation',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'implement_issue',
] as const;

function conservativeDefaults(owner: string, name: string): RepositoryPolicyV1 {
  return repositoryPolicyV1.parse({
    schemaVersion: 1,
    repository: { owner, name },
    autonomy: { level: 'assist' },
    triggers: {},
    manualCommands: [...DEFAULT_MANUAL_COMMANDS],
    actions: {
      allow: [],
      requireApproval: ['pull_request.merge', 'workflow_file.write'],
      deny: [],
    },
    validation: { obligations: [] },
    limits: { maxFilesChanged: 25, maxIterations: 5, maxRuntimeMinutes: 30 },
  });
}

export async function resolveManualCommandsForRepository(input: {
  readonly pool: DevGuardPool | undefined;
  readonly repositoryId: string;
  readonly owner?: string | undefined;
  readonly name?: string | undefined;
}): Promise<ReadonlySet<string>> {
  if (input.pool === undefined) {
    return new Set(DEFAULT_MANUAL_COMMANDS);
  }
  const policyStore = new PolicyVersionStore(input.pool);
  const active = await policyStore.getActive(input.repositoryId);
  if (active === null) {
    const defaults = conservativeDefaults(input.owner ?? 'owner', input.name ?? 'repo');
    return new Set(defaults.manualCommands);
  }
  const parsed = repositoryPolicyV1.safeParse(active.policyJson);
  if (!parsed.success) {
    return new Set(DEFAULT_MANUAL_COMMANDS);
  }
  return new Set(parsed.data.manualCommands);
}

/** Composition-owned policy port; routes must not construct PolicyVersionStore. */
export interface ManualCommandPolicyPort {
  resolve(input: {
    readonly repositoryId: string;
    readonly owner?: string | undefined;
    readonly name?: string | undefined;
  }): Promise<ReadonlySet<string>>;
}

export class ManualCommandPolicyAdapter implements ManualCommandPolicyPort {
  constructor(private readonly pool: DevGuardPool | undefined) {}

  resolve(input: {
    readonly repositoryId: string;
    readonly owner?: string | undefined;
    readonly name?: string | undefined;
  }): Promise<ReadonlySet<string>> {
    return resolveManualCommandsForRepository({ ...input, pool: this.pool });
  }
}

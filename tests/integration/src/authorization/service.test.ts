import { describe, expect, it } from 'vitest';
import { repositoryForbidden } from '@devguard/errors';
import {
  RepositoryAuthorizationService,
  requiresFreshCheck,
  type AuthorizationEvidencePort,
  type AuthorizationEvidenceRecord,
  type AuthorizationQueryShape,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
} from '@devguard/authorization';

function fixedPorts(role: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none') {
  const local: LocalRepositoryAccessPort = {
    findLinkage: async (repositoryId) =>
      repositoryId === 'missing-repo' ? undefined : { status: 'active', installationRef: 'inst-1' },
    isConnectingOwner: async () => true,
  };
  const github: GitHubPermissionPort = {
    fetchUserRole: async () => ({
      role,
      snapshotHash: `sha:${role}`,
    }),
  };
  const appended: AuthorizationEvidenceRecord[] = [];
  const evidence: AuthorizationEvidencePort = {
    append: async (record) => {
      appended.push(record);
    },
    findFresh: async () => undefined,
  };
  return { local, github, evidence, appended };
}

function service(
  ports: ReturnType<typeof fixedPorts>,
  options: { ttl?: number; linkageStatus?: 'active' | 'disconnected' } = {},
) {
  if (options.linkageStatus === 'disconnected') {
    ports.local.findLinkage = async () => ({ status: 'disconnected', installationRef: 'inst-1' });
  }
  return new RepositoryAuthorizationService({
    local: ports.local,
    github: ports.github,
    evidence: ports.evidence,
    readCacheTtlSeconds: options.ttl ?? 60,
    now: () => new Date(0),
  });
}

const USER: AuthorizationQueryShape['principal'] = {
  kind: 'user',
  userId: 'u-1',
  issuer: 'https://github.com',
  providerSubject: '12345',
};

describe('C006 capability matrix', () => {
  it('maps role floors deterministically across capabilities', async () => {
    const writerPorts = fixedPorts('write');
    const writerService = service(writerPorts);
    const allowed = await writerService.authorize({
      principal: USER,
      repositoryId: crypto.randomUUID(),
      capability: 'workflow:start',
    });
    expect(allowed).toMatchObject({ effect: 'allow', reasonCode: 'role_satisfies_floor' });

    const denied = await service(fixedPorts('read')).authorize({
      principal: USER,
      repositoryId: crypto.randomUUID(),
      capability: 'policy:write',
    });
    expect(denied).toMatchObject({ effect: 'deny', reasonCode: 'role_below_floor' });
  });

  it('forces fresh checks for privileged capabilities regardless of cache', async () => {
    expect(requiresFreshCheck('approval:resolve')).toBe(true);
    expect(requiresFreshCheck('policy:write')).toBe(true);
    expect(requiresFreshCheck('repository:privileged_action')).toBe(true);
    expect(requiresFreshCheck('workflow:start')).toBe(false);
  });

  it('fails closed when the permission provider is unavailable', async () => {
    const ports = fixedPorts('admin');
    ports.github.fetchUserRole = async () => {
      throw new Error('boom');
    };
    let code = '';
    try {
      await service(ports).authorize({
        principal: USER,
        repositoryId: crypto.randomUUID(),
        capability: 'repository:read',
      });
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('is non-enumerating: missing linkage and disconnected both throw the same forbidden error', async () => {
    const missing = service(fixedPorts('admin'));
    const disconnected = service(fixedPorts('admin'), { linkageStatus: 'disconnected' });
    for (const svc of [missing, disconnected]) {
      let thrown: unknown;
      try {
        await svc.authorize({
          principal: USER,
          repositoryId: 'missing-repo',
          capability: 'repository:read',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(repositoryForbidden(new Error()).constructor);
      expect((thrown as { message?: string }).message).toBeDefined();
    }
  });

  it('appends allow-evidence with expiry only for cacheable reads', async () => {
    const ports = fixedPorts('maintain');
    await service(ports, { ttl: 30 }).authorize({
      principal: USER,
      repositoryId: crypto.randomUUID(),
      capability: 'workflow:start', // not fresh-required → evidence gets expiry
    });
    expect(ports.appended).toHaveLength(1);
    expect(ports.appended[0]?.expiresAt).toBeDefined();

    const privilegedPorts = fixedPorts('admin');
    await service(privilegedPorts).authorize({
      principal: USER,
      repositoryId: crypto.randomUUID(),
      capability: 'approval:resolve', // fresh-required → no expiry on evidence
    });
    expect(privilegedPorts.appended[0]?.expiresAt).toBeUndefined();
  });
});

import type { RepositoryAuthorizationService } from '@devguard/authorization';
import type { CommentAuthorizerPort } from '@devguard/workflows';

export function repositoryAuthorizerAdapter(
  authorizer: RepositoryAuthorizationService,
): CommentAuthorizerPort {
  return {
    authorizeWorkflowStart: async ({ userId, issuer, providerSubject, repositoryId }) => {
      const result = await authorizer.authorize({
        principal: { kind: 'user', userId, issuer, providerSubject },
        repositoryId,
        capability: 'workflow:start',
      });
      return {
        allowed: result.effect === 'allow',
        reasonCode: result.reasonCode,
      };
    },
  };
}

import { DomainError } from '../../../../server/common/domain-error.ts';
import { toAgentEndpointSelection } from '../../../../server/controller/agents/execution-planning.ts';
import { ApiProviderEndpointResolver } from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import type { StoredApiProvider } from '../../../../server/controller/api-providers/store.ts';

const { apiProviders } = await Bun.file(new URL('../../../garcon-stores/tests/fixtures/api-provider-endpoint-resolver.json', import.meta.url)).json() as {
  apiProviders: StoredApiProvider[];
};
const resolver = new ApiProviderEndpointResolver(
  executor => {
    if (executor !== 'local') throw new DomainError('EXECUTOR_NOT_FOUND', 'Executor not found', 404);
    return apiProviders.filter(profile => profile.id === 'acme');
  },
  () => ['openai-compatible'],
);

export function endpointProjectionTrace(scenario: string) {
  const selection = resolver.resolveSelection({ agentId: 'test', model: 'acme-code', ...(
    scenario === 'native' ? {} : { apiProviderId: 'acme', modelEndpointId: 'acme_openai' }
  ) });
  if (scenario === 'metadata-only') delete selection.endpoint;
  if (scenario === 'missing-protocol') selection.protocol = null;
  if (scenario === 'stale' && selection.endpoint?.credential) {
    selection.endpoint = { ...selection.endpoint, credential: {
      ...selection.endpoint.credential, revision: selection.endpoint.credential.revision - 1,
    } };
  }
  if (scenario === 'wrong-executor') selection.executorId = 'not-configured';
  try {
    return { wire: JSON.stringify(toAgentEndpointSelection(resolver, selection)), error: null, code: null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { wire: null, error: error.message, code: error instanceof DomainError ? error.code : null };
  }
}

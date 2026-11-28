import {
  ApiProviderEndpointResolver,
  assertSameApiProviderBoundary as assertBoundary,
} from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import { DomainError } from '../../../../server/common/domain-error.ts';
import type { StoredApiProvider } from '../../../../server/controller/api-providers/store.ts';

const { apiProviders } = await Bun.file(new URL('../fixtures/api-provider-endpoint-resolver.json', import.meta.url)).json() as {
  apiProviders: StoredApiProvider[];
};
const remote = '11111111-1111-4111-8111-111111111111';
const resolver = new ApiProviderEndpointResolver((executor) => {
  if (executor === 'local') return apiProviders.filter(({ id }) => id === 'acme');
  if (executor === remote) return apiProviders.filter(({ id }) => id === 'acme' || id === 'remote_only');
  throw new DomainError('EXECUTOR_NOT_FOUND', 'Executor not found', 404);
}, (agent, executor) => {
  if (executor === remote) return ['anthropic-messages'];
  if (['claude', 'direct-anthropic-compatible'].includes(agent)) return ['anthropic-messages'];
  if (['codex', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(agent)) return ['openai-compatible'];
  return [];
}, () => apiProviders);

export const resolveSelection = resolver.resolveSelection.bind(resolver);
export const describePrevious = resolver.describePrevious.bind(resolver);
export const modelSupportsImages = resolver.modelSupportsImages.bind(resolver);
export function assertSameApiProviderBoundary(previous: boolean, next: boolean): void {
  const selection = (isLocal: boolean) => ({ model: 'fixture', apiProviderId: null, endpointId: null, protocol: null, isLocal });
  assertBoundary(selection(previous), selection(next));
}

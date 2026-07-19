import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type {
  ApiProviderEndpointResolver,
  ResolvedModelSelection,
} from '../api-providers/endpoint-resolver.js';
import type { AgentChatEntry } from './session-types.js';
import { requireChatExecutionConfig } from './session-types.js';

export type RequiredAgentChatEntry = AgentChatEntry & ReturnType<typeof requireChatExecutionConfig>;

export function requireAgentChatEntry(
  chatId: string,
  entry: AgentChatEntry | null | undefined,
): RequiredAgentChatEntry {
  const execution = requireChatExecutionConfig(chatId, entry);
  if (!entry) throw new Error(`Session not initialized: ${chatId}`);
  return { ...entry, ...execution };
}

export function toAgentEndpointSelection(
  endpointResolver: ApiProviderEndpointResolver,
  selection: ResolvedModelSelection,
): AgentEndpointSelection | null {
  const reference = endpointResolver.resolveEndpointReference(selection);
  if (
    !reference
    || !selection.apiProviderId
    || !selection.endpointId
    || !selection.protocol
  ) return null;
  return {
    apiProviderId: selection.apiProviderId,
    endpointId: selection.endpointId,
    protocol: selection.protocol,
    baseUrl: reference.endpoint.baseUrl,
    model: selection.model,
    isLocal: selection.isLocal,
    credential: {
      kind: 'api-provider-endpoint',
      apiProviderId: selection.apiProviderId,
      endpointId: selection.endpointId,
    },
  };
}

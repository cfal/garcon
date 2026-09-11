import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentAdmittedEndpoint } from '@garcon/server-agent-interface';
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
  return toAdmittedEndpoint(endpointResolver, selection)?.selection ?? null;
}

export function toAdmittedEndpoint(
  endpointResolver: ApiProviderEndpointResolver,
  selection: ResolvedModelSelection,
): AgentAdmittedEndpoint | null {
  const reference = endpointResolver.resolveEndpointReference(selection);
  if (
    !reference
    || !selection.apiProviderId
    || !selection.endpointId
    || !selection.protocol
  ) return null;
  return {
    credential: reference.endpoint.apiKey || null,
    selection: {
      apiProviderId: selection.apiProviderId,
      endpointId: selection.endpointId,
      providerLabel: reference.apiProvider.label || selection.apiProviderId,
      protocol: selection.protocol,
      baseUrl: reference.endpoint.baseUrl,
      model: selection.model,
      isLocal: selection.isLocal,
      capabilities: structuredClone(reference.endpoint.capabilities ?? null),
      headers: { ...(reference.endpoint.headers ?? {}) },
    },
  };
}

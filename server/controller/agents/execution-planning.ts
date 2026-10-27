import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { AgentCallError, type AgentIntegration } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
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

export function executionSettings(
  integration: AgentIntegration, entry: AgentChatEntry, submitted?: AgentSettingsEnvelope,
): AgentSettingsEnvelope {
  if (entry.agentId !== integration.descriptor.id
    || effectiveExecutorId(entry.executorId) !== integration.producers.scope.executorId) {
    throw new AgentCallError('not-dispatched', 'Chat execution target changed during preparation', 'STALE_RESOURCE');
  }
  return integration.settings.parse(submitted ?? entry.agentSettingsById?.[entry.agentId] ?? integration.settings.defaults());
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
  if (selection.endpoint) return selection.endpoint;
  return {
    apiProviderId: selection.apiProviderId,
    endpointId: selection.endpointId,
    providerLabel: reference.apiProvider.label || selection.apiProviderId,
    protocol: selection.protocol,
    baseUrl: reference.endpoint.baseUrl,
    model: selection.model,
    isLocal: selection.isLocal,
    capabilities: reference.endpoint.capabilities ?? null,
    headers: { ...(reference.endpoint.headers ?? {}) },
    credential: {
      kind: 'api-provider-endpoint',
      apiProviderId: selection.apiProviderId,
      endpointId: selection.endpointId,
      revision: reference.apiProvider.revision,
    },
  };
}

import type { ApiProtocol } from '../../common/api-providers.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '../../common/chat-modes.js';
import type {
  ApiProviderEndpointResolver,
  ResolvedModelSelection,
} from '../api-providers/endpoint-resolver.js';
import type { AgentChatEntry } from './session-types.js';
import { requireChatExecutionConfig } from './session-types.js';
import type { Agent, AgentEndpointRuntimeConfig } from './types.js';

export type RequiredAgentChatEntry = AgentChatEntry & {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
};

export function requireAgentChatEntry(
  chatId: string,
  entry: AgentChatEntry | null | undefined,
): RequiredAgentChatEntry {
  const execution = requireChatExecutionConfig(chatId, entry);
  if (!entry) {
    throw new Error(`Session not initialized: ${chatId}`);
  }
  return {
    ...entry,
    ...execution,
  };
}

export function selectionRequestFields(selection: ResolvedModelSelection): {
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
} {
  if (!selection.endpointId) return {};
  return {
    apiProviderId: selection.apiProviderId,
    modelEndpointId: selection.endpointId,
    modelProtocol: selection.protocol,
  };
}

export function endpointRuntimeConfig(
  agent: Agent,
  endpointResolver: ApiProviderEndpointResolver,
  selection: ResolvedModelSelection,
): AgentEndpointRuntimeConfig {
  if (!agent.prepareEndpointRuntime) return {};
  const reference = endpointResolver.resolveEndpointReference(selection);
  if (!reference || !selection.apiProviderId || !selection.endpointId || !selection.protocol) return {};
  return agent.prepareEndpointRuntime({
    model: selection.model,
    apiProviderId: selection.apiProviderId,
    modelEndpointId: selection.endpointId,
    modelProtocol: selection.protocol,
    isLocal: selection.isLocal,
    ...reference,
  }) ?? {};
}

export function mergeRuntimeConfig<T extends Record<string, unknown>>(
  target: T,
  runtimeConfig: AgentEndpointRuntimeConfig,
): T & AgentEndpointRuntimeConfig {
  return Object.assign(target, runtimeConfig);
}

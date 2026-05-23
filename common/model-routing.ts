// Shared compatibility rules between agents and API provider endpoints.

import {
  DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
  DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  type AgentId,
  type BuiltinAgentId,
} from './agents.js';
import type { ApiProtocol, OpenAiEndpointCapabilities } from './api-providers.js';

const AGENT_IDS_BY_PROTOCOL: Record<ApiProtocol, readonly BuiltinAgentId[]> = {
  'anthropic-messages': ['claude', DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID],
  'openai-compatible': [
    'codex',
    DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
    DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
  ],
};

const ENDPOINT_MODEL_VALUE_SEPARATOR = ':';

export interface EndpointAgentCompatibilityInput {
  protocol: ApiProtocol;
  capabilities?: OpenAiEndpointCapabilities;
}

export function endpointModelOptionValue(endpointId: string, rawModel: string): string {
  return `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}${rawModel}`;
}

export function rawModelFromEndpointOptionValue(endpointId: string, selectedModel: string): string {
  const prefix = `${endpointId}${ENDPOINT_MODEL_VALUE_SEPARATOR}`;
  return selectedModel.startsWith(prefix) ? selectedModel.slice(prefix.length) : selectedModel;
}

export function agentsForProtocol(protocol: ApiProtocol): readonly BuiltinAgentId[] {
  return AGENT_IDS_BY_PROTOCOL[protocol];
}

export function isAgentCompatibleWithProtocol(agentId: string, protocol: ApiProtocol): boolean {
  return agentsForProtocol(protocol).includes(agentId as BuiltinAgentId);
}

export function endpointSupportsAgent(
  agentId: AgentId,
  endpoint: EndpointAgentCompatibilityInput,
): boolean {
  if (endpoint.protocol === 'anthropic-messages') {
    return agentId === 'claude' || agentId === DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID;
  }

  const capabilities = endpoint.capabilities ?? {
    chatCompletions: false,
    responses: false,
  };
  if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
    return capabilities.chatCompletions;
  }
  if (agentId === 'codex' || agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
    return capabilities.responses;
  }
  return false;
}

export function agentsForEndpoint(endpoint: EndpointAgentCompatibilityInput): AgentId[] {
  return agentsForProtocol(endpoint.protocol)
    .filter((agentId) => endpointSupportsAgent(agentId, endpoint));
}

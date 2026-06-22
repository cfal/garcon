import type { AgentCapabilities, SupportedAgentProtocol } from './types.js';

export interface CreateAgentCapabilitiesInput {
  supportsFork?: boolean;
  supportsForkWhileRunning?: boolean;
  supportsImages?: boolean;
  acceptsApiProviderEndpoints?: boolean;
  supportedProtocols?: SupportedAgentProtocol[];
  authLoginSupported?: boolean;
  getModels?: AgentCapabilities['getModels'];
}

export function createAgentCapabilities(input: CreateAgentCapabilitiesInput = {}): AgentCapabilities {
  return {
    supportsFork: input.supportsFork ?? false,
    supportsForkWhileRunning: input.supportsForkWhileRunning ?? false,
    supportsImages: input.supportsImages ?? false,
    acceptsApiProviderEndpoints: input.acceptsApiProviderEndpoints ?? false,
    supportedProtocols: input.supportedProtocols ?? [],
    authLoginSupported: input.authLoginSupported ?? false,
    ...(input.getModels ? { getModels: input.getModels } : {}),
  };
}

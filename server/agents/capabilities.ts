import type { AgentCapabilityDriver, SupportedAgentProtocol } from './types.js';

export interface CreateAgentCapabilitiesInput {
  supportsFork?: boolean;
  supportsImages?: boolean;
  acceptsApiProviderEndpoints?: boolean;
  supportedProtocols?: SupportedAgentProtocol[];
  authLoginSupported?: boolean;
  getModels?: AgentCapabilityDriver['getModels'];
}

export function createAgentCapabilities(input: CreateAgentCapabilitiesInput = {}): AgentCapabilityDriver {
  return {
    supportsFork: input.supportsFork ?? false,
    supportsImages: input.supportsImages ?? false,
    acceptsApiProviderEndpoints: input.acceptsApiProviderEndpoints ?? false,
    supportedProtocols: input.supportedProtocols ?? [],
    authLoginSupported: input.authLoginSupported ?? false,
    ...(input.getModels ? { getModels: input.getModels } : {}),
  };
}

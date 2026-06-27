import type { AgentCapabilities, SupportedAgentProtocol } from './types.js';

export interface CreateAgentCapabilitiesInput {
  supportsFork?: boolean;
  supportsForkAtMessage?: boolean;
  supportsForkWhileRunning?: boolean;
  supportsUpdateProjectPath?: boolean;
  supportsImages?: boolean;
  acceptsApiProviderEndpoints?: boolean;
  supportedProtocols?: SupportedAgentProtocol[];
  authLoginSupported?: boolean;
  getModels?: AgentCapabilities['getModels'];
}

export function createAgentCapabilities(input: CreateAgentCapabilitiesInput = {}): AgentCapabilities {
  return {
    supportsFork: input.supportsFork ?? false,
    supportsForkAtMessage: input.supportsForkAtMessage ?? false,
    supportsForkWhileRunning: input.supportsForkWhileRunning ?? false,
    supportsUpdateProjectPath: input.supportsUpdateProjectPath ?? false,
    supportsImages: input.supportsImages ?? false,
    acceptsApiProviderEndpoints: input.acceptsApiProviderEndpoints ?? false,
    supportedProtocols: input.supportedProtocols ?? [],
    authLoginSupported: input.authLoginSupported ?? false,
    ...(input.getModels ? { getModels: input.getModels } : {}),
  };
}

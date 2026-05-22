import type { HarnessCapabilityDriver, SupportedHarnessProtocol } from './types.js';

export interface CreateHarnessCapabilitiesInput {
  supportsFork?: boolean;
  supportsImages?: boolean;
  acceptsApiProviderEndpoints?: boolean;
  supportedProtocols?: SupportedHarnessProtocol[];
  authLoginSupported?: boolean;
  getModels?: HarnessCapabilityDriver['getModels'];
}

export function createHarnessCapabilities(input: CreateHarnessCapabilitiesInput = {}): HarnessCapabilityDriver {
  return {
    supportsFork: input.supportsFork ?? false,
    supportsImages: input.supportsImages ?? false,
    acceptsApiProviderEndpoints: input.acceptsApiProviderEndpoints ?? false,
    supportedProtocols: input.supportedProtocols ?? [],
    authLoginSupported: input.authLoginSupported ?? false,
    ...(input.getModels ? { getModels: input.getModels } : {}),
  };
}

import type { ProviderConfigurationRequest } from './provider-configuration.js';

export interface ProviderTextGenerationRequest {
  readonly prompt: string;
  readonly configuration: Omit<ProviderConfigurationRequest, 'permissionMode'>;
  readonly timeoutMs: number;
}

/** Generates supplied text on one instance without granting access to tools or a project. */
export interface ProviderTextGenerationService {
  run(request: ProviderTextGenerationRequest, signal: AbortSignal): Promise<string>;
}

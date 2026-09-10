import type { ProviderConfigurationRequest } from './provider-configuration.js';

export interface ProviderSingleQueryRequest {
  readonly prompt: string;
  readonly projectPath: string;
  readonly configuration: Omit<ProviderConfigurationRequest, 'permissionMode'>;
  readonly timeoutMs?: number;
}

/** Preserves standalone one-shot behavior; absence of permission bypass is not a tool-free guarantee. */
export interface ProviderSingleQueryService {
  readonly runsToolsWithoutPermission: boolean;
  run(request: ProviderSingleQueryRequest, signal: AbortSignal): Promise<string>;
}

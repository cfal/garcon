import type { AgentCatalogSnapshot } from '@garcon/server-agent-interface';

export interface ProviderCatalogRequest {
  readonly strict: boolean;
}

/** Reads one bound instance's catalog without selecting another provider or profile. */
export interface ProviderCatalogService {
  snapshot(request: ProviderCatalogRequest, signal: AbortSignal): Promise<AgentCatalogSnapshot>;
}

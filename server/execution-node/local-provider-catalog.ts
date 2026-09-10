import type { AgentCatalogSnapshot, AgentIntegration } from '@garcon/server-agent-interface';
import type { ProviderCatalogRequest, ProviderCatalogService } from '../execution-nodes/provider-catalog.js';

export class LocalProviderCatalogService implements ProviderCatalogService {
  constructor(private readonly integration: Pick<AgentIntegration, 'catalog'>) {}

  async snapshot(request: ProviderCatalogRequest, signal: AbortSignal): Promise<AgentCatalogSnapshot> {
    signal.throwIfAborted();
    const snapshot = await this.integration.catalog.snapshot({ strict: request.strict, signal });
    signal.throwIfAborted();
    return structuredClone(snapshot);
  }
}

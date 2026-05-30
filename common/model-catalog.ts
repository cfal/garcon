import type { AgentCatalogEntry } from './agents.js';
import type { ApiProviderCatalogEntry } from './api-providers.js';

export interface ModelCatalogResponse {
  catalog: {
    agents: AgentCatalogEntry[];
    apiProviders: ApiProviderCatalogEntry[];
  };
}

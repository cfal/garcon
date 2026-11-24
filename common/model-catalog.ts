import type { AgentCatalogEntry } from './agents.js';
import type { ApiProviderCatalogEntry } from './api-providers.js';

export const CATALOG_INSTANCE_HEADER = 'X-Garcon-Executor-Instance';
export const LOGIN_AGENT_QUERY = 'loginAgent';

export interface ModelCatalogResponse {
  catalog: {
    agents: AgentCatalogEntry[];
    apiProviders: ApiProviderCatalogEntry[];
  };
}

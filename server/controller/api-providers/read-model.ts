// Minimal read surface exposed to agents that consume API provider endpoints.

import type { StoredApiProvider, StoredApiProviderEndpoint } from './store.js';

export interface ApiProviderReader {
  list(): StoredApiProvider[];
  getEndpoint(endpointId: string): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } | null;
}

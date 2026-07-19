import type { StoredApiProvider, StoredApiProviderEndpoint } from './types.js';

export interface ApiProviderReader {
  list(): StoredApiProvider[];
  getEndpoint(endpointId: string): {
    apiProvider: StoredApiProvider;
    endpoint: StoredApiProviderEndpoint;
  } | null;
}

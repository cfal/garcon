import type { ApiProtocol } from '../api-providers.js';

export interface ResolvedModelSelection {
  readonly model: string;
  readonly apiProviderId: string | null;
  readonly modelEndpointId: string | null;
  readonly modelProtocol: ApiProtocol | null;
}

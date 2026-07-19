import type { ApiProtocol } from './api-providers.js';

export interface AgentAttachment {
  readonly kind: 'image';
  readonly data: string;
  readonly name: string | null;
  readonly mimeType: string;
}

export interface AgentCredentialReference {
  readonly kind: 'api-provider-endpoint';
  readonly apiProviderId: string;
  readonly endpointId: string;
}

export interface AgentEndpointSelection {
  readonly apiProviderId: string;
  readonly endpointId: string;
  readonly protocol: ApiProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly isLocal: boolean;
  readonly credential: AgentCredentialReference | null;
}

export interface AgentAuthStatus {
  readonly authenticated: boolean;
  readonly canReauth: boolean;
  readonly label: string;
  readonly source: 'oauth' | 'api-key' | 'environment' | 'cli' | 'none' | 'unknown';
  readonly detail?: string;
}

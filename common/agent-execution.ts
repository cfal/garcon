import type { ApiProtocol, OpenAiEndpointCapabilities } from './api-providers.js';

export interface AgentAttachment {
  readonly kind: 'image';
  readonly data: string;
  readonly name: string | null;
  readonly mimeType: string;
}

export interface AgentEndpointSelection {
  readonly apiProviderId: string;
  readonly endpointId: string;
  readonly providerLabel: string;
  readonly protocol: ApiProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly isLocal: boolean;
  readonly capabilities: OpenAiEndpointCapabilities | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface AgentAuthStatus {
  readonly authenticated: boolean;
  readonly canReauth: boolean;
  readonly label: string;
  readonly source: 'oauth' | 'api-key' | 'environment' | 'cli' | 'none' | 'unknown';
  readonly detail?: string;
}

export interface AgentReadiness {
  readonly ready: boolean;
  readonly nativeReady: boolean;
  readonly endpointReady: boolean;
  readonly reason: string;
}

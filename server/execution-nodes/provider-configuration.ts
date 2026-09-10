import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { AgentSessionConfiguration } from '@garcon/server-agent-interface';

export interface ProviderConfigurationRequest {
  readonly model: string;
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: ThinkingMode;
  readonly settings: AgentSettingsEnvelope | null;
  readonly endpoint: AgentEndpointSelection | null;
}

export interface ProviderConfigurationUpdateRequest {
  readonly previous: ProviderConfigurationRequest;
  readonly next: Pick<ProviderConfigurationRequest, 'model' | 'endpoint'>;
  readonly patch: {
    readonly permissionMode?: PermissionMode;
    readonly thinkingMode?: ThinkingMode;
    readonly settings?: JsonObject;
  };
}

export interface ProviderConfigurationUpdate {
  readonly previous: AgentSessionConfiguration;
  readonly next: AgentSessionConfiguration;
}

/** Validates configuration on one bound instance without changing provider execution or controller state. */
export interface ProviderConfigurationService {
  resolve(request: ProviderConfigurationRequest, signal: AbortSignal): Promise<AgentSessionConfiguration>;
  prepareUpdate(request: ProviderConfigurationUpdateRequest, signal: AbortSignal): Promise<ProviderConfigurationUpdate>;
}

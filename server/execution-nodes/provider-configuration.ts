import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { AgentAdmittedEndpoint, AgentNativeSessionRef, AgentPreparedProviderConfiguration, AgentSessionConfiguration } from '@garcon/server-agent-interface';

export interface ProviderConfigurationRequest {
  readonly model: string;
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: ThinkingMode;
  readonly settings: AgentSettingsEnvelope | null;
  readonly endpoint: AgentAdmittedEndpoint | null;
}

export interface ProviderConfigurationUpdateRequest {
  readonly previous: Omit<ProviderConfigurationRequest, 'endpoint'> & { readonly endpoint: AgentEndpointSelection | null };
  readonly next: Pick<AgentSessionConfiguration, 'model' | 'endpoint'>;
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

export interface ProviderSessionConfigurationRequest {
  /** Remote owners revalidate this snapshot beside mutation; local calls share controller ownership. */
  readonly expected: {
    readonly agentSessionId: string;
    readonly nativeSession: AgentNativeSessionRef | null;
    readonly projectPath: string;
  };
  readonly previous: AgentSessionConfiguration;
  readonly next: AgentSessionConfiguration;
}

export type ProviderSessionConfigurationResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'unknown' };

/** Owns configuration validation and live application on one bound instance. Preparation does not mutate execution. */
export interface ProviderConfigurationService {
  resolve(request: ProviderConfigurationRequest, signal: AbortSignal): Promise<AgentPreparedProviderConfiguration>;
  prepareUpdate(request: ProviderConfigurationUpdateRequest, signal: AbortSignal): Promise<ProviderConfigurationUpdate>;
  /** An unknown outcome forbids controller persistence and automatic retry. */
  apply(request: ProviderSessionConfigurationRequest, signal: AbortSignal): Promise<ProviderSessionConfigurationResult>;
}

import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { JsonObject } from '@garcon/common/json';
import type { ExecutionLocation } from '../../common/execution-location.js';
import type { AgentAdmittedEndpoint, AgentPreparedProviderConfiguration, AgentSessionConfiguration,
  AgentSessionConfigurationPrepareRequest, AgentSessionConfigurationCommitResult, AgentSessionConfigurationRejection } from '@garcon/server-agent-interface';

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

export interface ProviderSessionConfigurationRequest extends Omit<AgentSessionConfigurationPrepareRequest, 'signal'> {
  readonly executionLocation: ExecutionLocation;
}

declare const providerSessionConfigurationOperation: unique symbol;

export interface ProviderSessionConfigurationOperation {
  readonly [providerSessionConfigurationOperation]: true;
}

export type ProviderSessionConfigurationPreparation =
  | { readonly kind: 'prepared'; readonly operation: ProviderSessionConfigurationOperation }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'not-required' }
  | AgentSessionConfigurationRejection;

export type ProviderSessionConfigurationResult = AgentSessionConfigurationCommitResult;

/** Resolves admitted credentials only inside the executing instance. */
export interface ProviderConfigurationResolver {
  resolve(request: ProviderConfigurationRequest, signal: AbortSignal): Promise<AgentPreparedProviderConfiguration>;
}

/** Owns credential-free settings validation and live application on one bound instance. */
export interface ProviderConfigurationService {
  prepareUpdate(request: ProviderConfigurationUpdateRequest, signal: AbortSignal): Promise<ProviderConfigurationUpdate>;
  prepareApply(request: ProviderSessionConfigurationRequest, signal: AbortSignal): Promise<ProviderSessionConfigurationPreparation>;
  /** An unknown outcome forbids controller persistence and automatic retry. */
  commit(operation: ProviderSessionConfigurationOperation, signal: AbortSignal): Promise<ProviderSessionConfigurationResult>;
  cancel(operation: ProviderSessionConfigurationOperation): Promise<void>;
}

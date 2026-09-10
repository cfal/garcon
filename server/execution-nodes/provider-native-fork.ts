import type { JsonObject } from '@garcon/common/json';
import type { AgentEstablishedSession, AgentNativeForkOutcome } from '@garcon/server-agent-interface';
import type { ProviderConfigurationRequest } from './provider-configuration.js';
import type { ProviderNativeChatReference } from './provider-native-sessions.js';

export interface ProviderNativeForkRequest {
  readonly chatId: string;
  readonly source: ProviderNativeChatReference;
  readonly configuration: ProviderConfigurationRequest;
  readonly providerMeta: JsonObject | null;
}

export interface ProviderNativeForkDiscardRequest {
  readonly session: AgentEstablishedSession;
}

/** Materialized results transfer cleanup ownership to the caller even when cancellation wins during the fork. */
export interface ProviderNativeForkService {
  fork(request: ProviderNativeForkRequest, signal: AbortSignal): Promise<AgentNativeForkOutcome>;
  discard(request: ProviderNativeForkDiscardRequest, signal: AbortSignal): Promise<void>;
}

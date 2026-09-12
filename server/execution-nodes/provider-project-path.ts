import type { AgentProjectPathUpdatePreparation } from '@garcon/server-agent-interface';
import type { ProviderNativeChatReference } from './provider-native-sessions.js';

export interface ProviderProjectPathUpdateRequest {
  readonly chat: ProviderNativeChatReference;
  readonly nextProjectPath: string;
}

export interface ProviderProjectPathUpdateService {
  /** Transfers confirmed preparation ownership even when cancellation races native completion. */
  prepare(request: ProviderProjectPathUpdateRequest, signal: AbortSignal): Promise<AgentProjectPathUpdatePreparation | void>;
}

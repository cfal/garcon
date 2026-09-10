import type {
  AgentChatReference,
  AgentNativeSessionRef,
  AgentTranscriptSourceLocation,
} from '@garcon/server-agent-interface';

export interface ProviderNativeChatReference extends Omit<AgentChatReference, 'settings'> {
  readonly settings: AgentChatReference['settings'] | null;
}

export interface ProviderNativeSessionRequest {
  readonly chat: ProviderNativeChatReference;
}

export interface ProviderNativeReleaseRequest extends ProviderNativeSessionRequest {
  readonly reason: 'deleted' | 'transferred';
}

export interface ProviderNativeSessionService {
  resolve(request: ProviderNativeSessionRequest, signal: AbortSignal): Promise<AgentNativeSessionRef | null>;
  describe(request: ProviderNativeSessionRequest, signal: AbortSignal): Promise<AgentTranscriptSourceLocation | null>;
  release(request: ProviderNativeReleaseRequest, signal: AbortSignal): Promise<void>;
}

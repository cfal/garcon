import type { AgentChatReference, AgentIntegration, AgentNativeSessionRef, AgentTranscriptSourceLocation } from '@garcon/server-agent-interface';
import type {
  ProviderNativeChatReference,
  ProviderNativeReleaseRequest,
  ProviderNativeSessionRequest,
  ProviderNativeSessionService,
} from '../execution-nodes/provider-native-sessions.js';

export class LocalProviderNativeSessionService implements ProviderNativeSessionService {
  constructor(private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'nativeSessions'>) {}

  async resolve(request: ProviderNativeSessionRequest, signal: AbortSignal): Promise<AgentNativeSessionRef | null> {
    signal.throwIfAborted();
    this.#assertOwner(request.chat);
    const sessions = this.integration.nativeSessions;
    if (!sessions) return null;
    const chat = this.#chat(request.chat);
    const reference = await sessions.resolveNativeSession({ chat, signal });
    signal.throwIfAborted();
    if (reference !== null && reference.ownerId !== this.integration.descriptor.id) {
      throw new Error('Native session owner mismatch');
    }
    return structuredClone(reference);
  }

  async describe(request: ProviderNativeSessionRequest, signal: AbortSignal): Promise<AgentTranscriptSourceLocation | null> {
    signal.throwIfAborted();
    this.#assertOwner(request.chat);
    const sessions = this.integration.nativeSessions;
    if (!sessions) return null;
    const source = await sessions.describeSource({ chat: this.#chat(request.chat), signal });
    signal.throwIfAborted();
    if (source !== null && ((source.kind !== 'filesystem-path' && source.kind !== 'provider-reference')
      || typeof source.value !== 'string' || source.value.length === 0)) {
      throw new Error('INVALID_TRANSCRIPT_SOURCE_DESCRIPTION');
    }
    return structuredClone(source);
  }

  async release(request: ProviderNativeReleaseRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#assertOwner(request.chat);
    const sessions = this.integration.nativeSessions;
    if (!sessions) return;
    const reason = request.reason;
    const chat = this.#chat(request.chat);
    await sessions.release({ chat, reason, signal });
    signal.throwIfAborted();
  }

  #chat(input: ProviderNativeChatReference): AgentChatReference {
    const chat = structuredClone(input);
    const settings = this.integration.settings.parse(structuredClone(chat.settings ?? this.integration.settings.defaults()));
    return { ...chat, settings: structuredClone(settings) };
  }

  #assertOwner(chat: ProviderNativeChatReference): void {
    const agentId = this.integration.descriptor.id;
    if (chat.agentId !== agentId || (chat.nativeSession !== null && chat.nativeSession.ownerId !== agentId)) {
      throw new Error('Native session owner mismatch');
    }
  }
}

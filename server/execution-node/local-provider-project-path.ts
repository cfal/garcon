import type { AgentIntegration, AgentProjectPathUpdatePreparation, AgentProjectPathUpdates } from '@garcon/server-agent-interface';
import type { ProviderProjectPathUpdateRequest, ProviderProjectPathUpdateService } from '../execution-nodes/provider-project-path.js';
import { assertNativeChatOwner, parseNativeChatReference } from './local-native-chat-reference.js';

export class LocalProviderProjectPathUpdateService implements ProviderProjectPathUpdateService {
  constructor(
    private readonly integration: Pick<AgentIntegration, 'descriptor' | 'settings'>,
    private readonly updates: AgentProjectPathUpdates,
  ) {}

  async prepare(request: ProviderProjectPathUpdateRequest, signal: AbortSignal): Promise<AgentProjectPathUpdatePreparation | void> {
    signal.throwIfAborted();
    const nextProjectPath = request.nextProjectPath;
    assertNativeChatOwner(this.integration, request.chat);
    const chat = parseNativeChatReference(this.integration, request.chat);
    signal.throwIfAborted();
    return this.updates.prepare({ chat, nextProjectPath, signal });
  }
}

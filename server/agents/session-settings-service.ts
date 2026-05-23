import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type {
  AgentChatEntry,
  AgentSessionSettingsPatch,
} from './session-types.js';
import type { AgentDirectory } from './directory.js';

function liveSessionSettingsPatch(patch: AgentSessionSettingsPatch): AgentSessionSettingsPatch {
  const live: AgentSessionSettingsPatch = {};
  if (patch.permissionMode !== undefined) live.permissionMode = patch.permissionMode;
  if (patch.thinkingMode !== undefined) live.thinkingMode = patch.thinkingMode;
  if (patch.claudeThinkingMode !== undefined) live.claudeThinkingMode = patch.claudeThinkingMode;
  if (patch.ampAgentMode !== undefined) live.ampAgentMode = patch.ampAgentMode;
  return live;
}

export class AgentSessionSettingsService {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #endpointResolver: ApiProviderEndpointResolver;

  constructor(args: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
  }) {
    this.#registry = args.registry;
    this.#directory = args.directory;
    this.#endpointResolver = args.endpointResolver;
  }

  async updateSessionSettings(
    chatId: string,
    patch: AgentSessionSettingsPatch,
  ): Promise<AgentChatEntry> {
    const entry = this.#registry.getChat(chatId);
    if (!entry) throw new Error(`Session not found: ${chatId}`);

    if (patch.model !== undefined || patch.apiProviderId !== undefined || patch.modelEndpointId !== undefined) {
      const previous = this.#endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: entry.model,
        apiProviderId: entry.apiProviderId,
        modelEndpointId: entry.modelEndpointId,
      });
      const next = this.#endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: patch.model ?? entry.model,
        apiProviderId: patch.apiProviderId !== undefined ? patch.apiProviderId : entry.apiProviderId,
        modelEndpointId: patch.modelEndpointId !== undefined ? patch.modelEndpointId : entry.modelEndpointId,
      });
      assertSameApiProviderBoundary(previous, next);
    }

    const livePatch = liveSessionSettingsPatch(patch);
    if (entry.agentSessionId && Object.keys(livePatch).length > 0) {
      await this.#directory.get(entry.agentId)?.runtime.updateSessionSettings?.(entry.agentSessionId, livePatch);
    }

    return this.#registry.updateChat(chatId, patch) ?? entry;
  }
}

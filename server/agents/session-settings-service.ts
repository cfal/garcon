import { normalizePermissionMode } from '../../common/chat-modes.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { AgentChatEntry, AgentSessionSettingsPatch } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import { toAgentEndpointSelection } from './execution-planning.js';
import {
  isThinkingModeSupported,
  normalizeSupportedThinkingMode,
} from '../../common/execution-defaults.js';
import { DomainError } from '../lib/domain-error.js';

export class AgentSessionSettingsService {
  readonly #lock: KeyedPromiseLock;

  constructor(private readonly deps: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    chatMutationLock?: KeyedPromiseLock;
  }) {
    this.#lock = deps.chatMutationLock ?? new KeyedPromiseLock();
  }

  updateSessionSettings(
    chatId: string,
    patch: AgentSessionSettingsPatch,
  ): Promise<AgentChatEntry> {
    return this.#lock.runExclusive(`chat:${chatId}`, async () => {
      const entry = this.deps.registry.getChat(chatId);
      if (!entry) throw new Error(`Session not found: ${chatId}`);
      const integration = this.deps.directory.require(entry.agentId);
      const previous = this.deps.endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: entry.model,
        apiProviderId: entry.apiProviderId,
        modelEndpointId: entry.modelEndpointId,
      });
      const next = this.deps.endpointResolver.resolveSelection({
        agentId: entry.agentId,
        model: patch.model ?? entry.model,
        apiProviderId: patch.apiProviderId !== undefined ? patch.apiProviderId : entry.apiProviderId,
        modelEndpointId: patch.modelEndpointId !== undefined
          ? patch.modelEndpointId
          : entry.modelEndpointId,
      });
      const endpoint = toAgentEndpointSelection(this.deps.endpointResolver, next);
      if (endpoint) {
        if (!integration.endpoints) {
          throw new Error(`Agent integration ${entry.agentId} does not accept API provider endpoints`);
        }
        await integration.endpoints.validate(endpoint);
      }
      assertSameApiProviderBoundary(previous, next);

      const permissionMode = normalizePermissionMode(patch.permissionMode ?? entry.permissionMode);
      if (
        patch.thinkingMode !== undefined
        && !isThinkingModeSupported(
          patch.thinkingMode,
          integration.descriptor.supportedThinkingModes,
        )
      ) {
        throw new DomainError(
          'VALIDATION_FAILED',
          `Thinking mode ${patch.thinkingMode} is not supported by ${entry.agentId}`,
          422,
        );
      }
      const thinkingMode = normalizeSupportedThinkingMode(
        patch.thinkingMode ?? entry.thinkingMode,
        integration.descriptor.supportedThinkingModes,
      );
      const currentSettings = integration.settings.parse(
        entry.agentSettingsById[entry.agentId] ?? integration.settings.defaults(),
      );
      const settings = patch.agentSettingsPatch
        ? integration.settings.applyPatch(currentSettings, patch.agentSettingsPatch)
        : currentSettings;

      if (entry.agentSessionId && integration.sessionConfiguration) {
        const configuration = {
          model: next.model,
          permissionMode,
          thinkingMode,
          settings,
          endpoint,
        };
        await integration.sessionConfiguration.apply(
          entry.agentSessionId,
          configuration,
          {
            model: previous.model,
            permissionMode: normalizePermissionMode(entry.permissionMode),
            thinkingMode: normalizeSupportedThinkingMode(
              entry.thinkingMode,
              integration.descriptor.supportedThinkingModes,
            ),
            settings: currentSettings,
            endpoint: toAgentEndpointSelection(this.deps.endpointResolver, previous),
          },
        );
      }

      const updated = await this.deps.registry.updateChat(chatId, {
        model: next.model,
        apiProviderId: next.apiProviderId,
        modelEndpointId: next.endpointId,
        modelProtocol: next.protocol,
        permissionMode,
        thinkingMode,
        agentSettingsById: {
          ...entry.agentSettingsById,
          [entry.agentId]: settings,
        },
      }, { flush: true });
      if (!updated) throw new Error(`Session not found: ${chatId}`);
      return updated;
    });
  }
}

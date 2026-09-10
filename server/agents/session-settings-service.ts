import { isDeepStrictEqual } from 'node:util';
import { sameExecutionOwner } from '../../common/execution-location.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { AgentChatEntry, AgentSessionSettingsPatch } from './session-types.js';
import type { AgentInstanceDirectory } from './instance-directory.js';
import { toAgentEndpointSelection } from './execution-planning.js';
import { DomainError } from '../lib/domain-error.js';

export class AgentSessionSettingsService {
  readonly #lock: KeyedPromiseLock;

  constructor(private readonly deps: {
    registry: IChatRegistry;
    instances: Pick<AgentInstanceDirectory, 'requireFor' | 'configurationFor'>;
    endpointResolver: ApiProviderEndpointResolver;
    chatMutationLock?: KeyedPromiseLock;
  }) {
    this.#lock = deps.chatMutationLock ?? new KeyedPromiseLock();
  }

  updateSessionSettings(
    chatId: string,
    input: AgentSessionSettingsPatch,
  ): Promise<AgentChatEntry> {
    const patch = structuredClone(input);
    return this.#lock.runExclusive(`chat:${chatId}`, async () => {
      const entry = structuredClone(this.deps.registry.getChat(chatId));
      if (!entry) throw new Error(`Session not found: ${chatId}`);
      const integration = this.deps.instances.requireFor(entry);
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
      assertSameApiProviderBoundary(previous, next);
      const configuration = await this.deps.instances.configurationFor(entry).prepareUpdate({
        previous: {
          model: previous.model,
          permissionMode: entry.permissionMode,
          thinkingMode: entry.thinkingMode,
          settings: entry.agentSettingsById[entry.agentId] ?? null,
          endpoint: toAgentEndpointSelection(this.deps.endpointResolver, previous),
        },
        next: { model: next.model, endpoint: toAgentEndpointSelection(this.deps.endpointResolver, next) },
        patch: {
          permissionMode: patch.permissionMode,
          thinkingMode: patch.thinkingMode,
          settings: patch.agentSettingsPatch,
        },
      }, new AbortController().signal);
      this.#assertCurrentTarget(chatId, entry);

      if (entry.agentSessionId && integration.sessionConfiguration) {
        await integration.sessionConfiguration.apply(
          entry.agentSessionId,
          structuredClone(configuration.next),
          structuredClone(configuration.previous),
        );
        this.#assertCurrentTarget(chatId, entry);
      }

      const { permissionMode, thinkingMode, settings } = configuration.next;
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

  #assertCurrentTarget(chatId: string, expected: AgentChatEntry): void {
    const current = this.deps.registry.getChat(chatId);
    if (!current || !sameExecutionOwner(current, expected)
      || current.agentOwnershipEpoch !== expected.agentOwnershipEpoch
      || current.agentSessionId !== expected.agentSessionId
      || current.projectPath !== expected.projectPath
      || !isDeepStrictEqual(current.nativeSession, expected.nativeSession)) {
      throw new DomainError('SOURCE_REVISION_CHANGED', 'Session changed while updating settings', 409);
    }
    this.deps.instances.requireFor(current);
  }
}

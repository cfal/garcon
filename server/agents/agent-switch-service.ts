import { normalizePermissionMode, normalizeThinkingMode } from '../../common/chat-modes.js';
import type { AgentModelPatchRequest } from '../../common/chat-command-contracts.js';
import type { IChatRegistry, ChatRegistryResolvedEntry } from '../chats/store.js';
import type { ChatCarryOverStore } from '../chats/chat-carryover-store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { AgentDirectory } from './directory.js';
import { toAgentChatReference } from './integration-chat-reference.js';

export type AgentSwitchErrorCode = 'SESSION_BUSY';

export class AgentSwitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: AgentSwitchErrorCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AgentSwitchError';
  }
}

export class AgentSwitchService {
  constructor(private readonly deps: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    carryOver: ChatCarryOverStore;
    ownership: AgentOwnershipJournal;
    chatMutationLock: KeyedPromiseLock;
  }) {}

  switchAgentModel(req: AgentModelPatchRequest): Promise<ChatRegistryResolvedEntry> {
    return this.deps.chatMutationLock.runExclusive(
      `chat:${req.chatId}`,
      () => this.#switchAgentCrossAgent(req),
    );
  }

  async #switchAgentCrossAgent(req: AgentModelPatchRequest): Promise<ChatRegistryResolvedEntry> {
    const entry = this.deps.registry.getChat(req.chatId);
    if (!entry) throw new Error(`Session not found: ${req.chatId}`);
    const source = this.deps.directory.get(entry.agentId);
    if (entry.agentSessionId && source?.execution.isRunning(entry.agentSessionId)) {
      throw new AgentSwitchError('Stop the current turn before switching agents.', 409, 'SESSION_BUSY');
    }

    const messages = entry.agentSessionId && source
      ? [...(await source.transcript.load({
          chat: toAgentChatReference(
            source,
            req.chatId,
            entry,
            this.deps.carryOver.getRevision(req.chatId),
          ),
          signal: new AbortController().signal,
        })).messages]
      : [];

    const target = this.deps.directory.require(req.agentId);
    const selection = this.deps.endpointResolver.resolveSelection({
      agentId: req.agentId,
      model: req.model,
      apiProviderId: req.apiProviderId,
      modelEndpointId: req.modelEndpointId,
    });
    const permissionMode = supportedValue(
      target.descriptor.supportedPermissionModes,
      normalizePermissionMode(entry.permissionMode),
      'default',
    );
    const thinkingMode = supportedValue(
      target.descriptor.supportedThinkingModes,
      normalizeThinkingMode(entry.thinkingMode),
      'none',
    );
    const updated = await this.deps.ownership.transfer({
      chatId: req.chatId,
      source: entry,
      targetAgentId: req.agentId,
      carryOverSegment: entry.agentSessionId ? {
        agentId: entry.agentId,
        model: entry.model,
        messages,
      } : null,
      patch: {
      model: selection.model,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
      agentSettingsById: {
        ...entry.agentSettingsById,
        [req.agentId]: target.settings.parse(
          entry.agentSettingsById[req.agentId] ?? target.settings.defaults(),
        ),
      },
      permissionMode,
      thinkingMode,
      },
    });
    return updated;
  }
}

function supportedValue<T extends string>(values: readonly string[], value: T, fallback: T): T {
  return values.includes(value) ? value : fallback;
}

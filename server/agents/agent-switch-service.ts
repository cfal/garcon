// Switches a chat to a different agent. Cross-agent switches cannot reuse the
// outgoing backend's native session (thinking-block signatures etc. are
// backend-bound), so they snapshot the prior transcript, render it to a seed,
// and stage a fresh session under the new agent that the next turn will start
// from. Same-agent model changes are a different concern owned by
// AgentSessionSettingsService via /api/v1/chats/model; the route rejects them
// here so this service stays cross-agent-only.

import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingModeForAgent,
} from '../../common/chat-modes.js';
import type { AgentModelPatchRequest } from '../../common/chat-command-contracts.js';
import type { IChatRegistry, ChatRegistryResolvedEntry } from '../chats/store.js';
import type { ChatCarryOverStore } from '../chats/chat-carryover-store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { AgentDirectory } from './directory.js';
import { permissionModeForAgent } from './permission-modes.js';
import { renderTranscriptSeed } from './shared/transcript-seed.js';

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
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #carryOver: ChatCarryOverStore;
  readonly #lock: KeyedPromiseLock;

  constructor(args: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    carryOver: ChatCarryOverStore;
    chatMutationLock: KeyedPromiseLock;
  }) {
    this.#registry = args.registry;
    this.#directory = args.directory;
    this.#endpointResolver = args.endpointResolver;
    this.#carryOver = args.carryOver;
    this.#lock = args.chatMutationLock;
  }

  // Serializes on the same `chat:<id>` key as ChatCommandService mutations so a
  // switch cannot race a concurrent send/fork/compaction on the same chat.
  switchAgentModel(req: AgentModelPatchRequest): Promise<ChatRegistryResolvedEntry> {
    return this.#lock.runExclusive(`chat:${req.chatId}`, () => this.#switchAgentCrossAgent(req));
  }

  async #switchAgentCrossAgent(
    req: AgentModelPatchRequest,
  ): Promise<ChatRegistryResolvedEntry> {
    const chatId = req.chatId;
    const entry = this.#registry.getChat(chatId);
    if (!entry) throw new Error(`Session not found: ${chatId}`);

    const fromAgent = this.#directory.get(entry.agentId);
    if (entry.agentSessionId && fromAgent?.runtime.isRunning(entry.agentSessionId)) {
      throw new AgentSwitchError(
        'Stop the current turn before switching agents.',
        409,
        'SESSION_BUSY',
      );
    }

    const messages = entry.agentSessionId
      ? (await fromAgent?.transcript.loadMessages(entry, { chatId })) ?? []
      : this.#carryOver.getMessages(chatId);

    const seed = renderTranscriptSeed(messages, { fromAgentLabel: fromAgent?.label });

    // Snapshot only when the outgoing agent produced native turns; a chained
    // switch (no native session yet) already has its history in carry-over.
    if (entry.agentSessionId) {
      this.#carryOver.appendSegment(chatId, {
        agentId: entry.agentId,
        model: entry.model,
        messages,
      });
    }

    const selection = this.#endpointResolver.resolveSelection({
      agentId: req.agentId,
      model: req.model,
      apiProviderId: req.apiProviderId,
      modelEndpointId: req.modelEndpointId,
    });

    const permissionMode = permissionModeForAgent(req.agentId, normalizePermissionMode(entry.permissionMode));
    const thinkingMode = normalizeThinkingModeForAgent(req.agentId, entry.thinkingMode);
    const claudeThinkingMode = normalizeClaudeThinkingMode(entry.claudeThinkingMode);
    const ampAgentMode = normalizeAmpAgentMode(entry.ampAgentMode);

    const updated = await this.#registry.updateChat(chatId, {
      agentId: req.agentId,
      model: selection.model,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
      agentSessionId: null,
      nativePath: null,
      carryOverContext: seed || null,
      permissionMode,
      thinkingMode,
      claudeThinkingMode,
      ampAgentMode,
    }, { flush: true });
    if (!updated) throw new Error(`Session not found: ${chatId}`);
    return updated;
  }
}

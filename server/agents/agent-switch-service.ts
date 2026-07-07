// Switches a chat's agent (or model within the same agent). Same-agent switches
// delegate to the endpoint boundary check and a registry patch. Cross-agent
// switches cannot reuse the outgoing backend's native session (thinking-block
// signatures etc. are backend-bound), so they snapshot the prior transcript,
// render it to a seed, and stage a fresh session under the new agent that the
// next turn will start from.

import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import type { AgentModelPatchRequest } from '../../common/chat-command-contracts.js';
import type { ChatRegistryEntry, IChatRegistry, ChatRegistryResolvedEntry } from '../chats/store.js';
import type { ChatCarryOverStore } from '../chats/chat-carryover-store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type { AgentDirectory } from './directory.js';
import { permissionModeForAgent } from './permission-modes.js';
import { renderTranscriptSeed } from './shared/transcript-seed.js';

export class AgentSwitchService {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #carryOver: ChatCarryOverStore;

  constructor(args: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    carryOver: ChatCarryOverStore;
  }) {
    this.#registry = args.registry;
    this.#directory = args.directory;
    this.#endpointResolver = args.endpointResolver;
    this.#carryOver = args.carryOver;
  }

  async switchAgentModel(req: AgentModelPatchRequest): Promise<ChatRegistryResolvedEntry> {
    const chatId = req.chatId;
    const entry = this.#registry.getChat(chatId);
    if (!entry) throw new Error(`Session not found: ${chatId}`);

    if (req.agentId === entry.agentId) {
      return this.#switchModelSameAgent(chatId, entry, req);
    }
    return this.#switchAgentCrossAgent(chatId, entry, req);
  }

  async #switchModelSameAgent(
    chatId: string,
    entry: ChatRegistryEntry,
    req: AgentModelPatchRequest,
  ): Promise<ChatRegistryResolvedEntry> {
    const agentId = entry.agentId;
    const previous = this.#endpointResolver.resolveSelection({
      agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    const next = this.#endpointResolver.resolveSelection({
      agentId,
      model: req.model,
      apiProviderId: req.apiProviderId !== undefined ? req.apiProviderId : entry.apiProviderId,
      modelEndpointId: req.modelEndpointId !== undefined ? req.modelEndpointId : entry.modelEndpointId,
    });
    assertSameApiProviderBoundary(previous, next);

    const updated = await this.#registry.updateChat(chatId, {
      model: next.model,
      apiProviderId: next.apiProviderId,
      modelEndpointId: next.endpointId,
      modelProtocol: next.protocol,
    }, { flush: true });
    if (!updated) throw new Error(`Session not found: ${chatId}`);
    return updated;
  }

  async #switchAgentCrossAgent(
    chatId: string,
    entry: ChatRegistryEntry,
    req: AgentModelPatchRequest,
  ): Promise<ChatRegistryResolvedEntry> {
    const fromAgent = this.#directory.get(entry.agentId);
    if (entry.agentSessionId && fromAgent?.runtime.isRunning(entry.agentSessionId)) {
      throw new Error('Stop the current turn before switching agents.');
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
    const thinkingMode = normalizeThinkingMode(entry.thinkingMode);
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

// Unified agent registry. Routes all operations through agent runtimes
// keyed by agent ID. Also provides preview/message loading, agent auth,
// readiness, and model catalog metadata.

import { resolveFileMentionsInCommand } from "../chats/file-mentions.ts";
import { getMaxSessions } from "../config.js";
import type { IChatRegistry } from "../chats/store.js";

import type { AgentCommandImage } from "../../common/ws-requests.js";
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from "../../common/chat-modes.js";
import type {
  AgentChatEntry,
  AgentEventMetadata,
  AgentSessionSettingsPatch,
  StartSessionRequest,
  StartedAgentSession,
  RunAgentTurnOptions,
} from "./session-types.js";
import { requireChatExecutionConfig } from "./session-types.js";
import type { ApiProviderEndpointResolver, ResolvedModelSelection } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type { Agent } from './types.js';
import type { AgentEndpointRuntimeConfig } from './types.js';
import {
  isVisibleAgentId,
  type AgentCatalogEntry,
  type AgentModelOption,
} from "../../common/agents.js";
import type { ApiProtocol } from "../../common/api-providers.js";
import type { AgentModelQuery } from './types.js';
import { AgentCatalogService } from './catalog-service.js';
import { AgentDirectory } from './directory.js';

function requireChatEntry(chatId: string, entry: AgentChatEntry | null | undefined): AgentChatEntry & {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
} {
  const execution = requireChatExecutionConfig(chatId, entry);
  if (!entry) {
    throw new Error(`Session not initialized: ${chatId}`);
  }
  return {
    ...entry,
    ...execution,
  };
}

interface TurnEventMetadata {
  clientRequestId?: string;
  upstreamRequestId?: string;
  turnId?: string;
}

function mergeTurnEventMetadata(
  base: TurnEventMetadata | undefined,
  event: AgentEventMetadata | undefined,
): TurnEventMetadata | undefined {
  const metadata = { ...(base ?? {}), ...(event ?? {}) };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function selectionRequestFields(selection: ResolvedModelSelection): {
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
} {
  if (!selection.endpointId) return {};
  return {
    apiProviderId: selection.apiProviderId,
    modelEndpointId: selection.endpointId,
    modelProtocol: selection.protocol,
  };
}

function mergeRuntimeConfig<T extends Record<string, unknown>>(
  target: T,
  runtimeConfig: AgentEndpointRuntimeConfig,
): T & AgentEndpointRuntimeConfig {
  return Object.assign(target, runtimeConfig);
}

function liveSessionSettingsPatch(patch: AgentSessionSettingsPatch): AgentSessionSettingsPatch {
  const live: AgentSessionSettingsPatch = {};
  if (patch.permissionMode !== undefined) live.permissionMode = patch.permissionMode;
  if (patch.thinkingMode !== undefined) live.thinkingMode = patch.thinkingMode;
  if (patch.claudeThinkingMode !== undefined) live.claudeThinkingMode = patch.claudeThinkingMode;
  if (patch.ampAgentMode !== undefined) live.ampAgentMode = patch.ampAgentMode;
  return live;
}

export class AgentRegistry {
  #registry: IChatRegistry;
  #directory: AgentDirectory;
  #endpointResolver: ApiProviderEndpointResolver;
  #catalog: AgentCatalogService;
  #turnMetadataByChatId = new Map<string, TurnEventMetadata>();

  constructor(args: {
    registry: IChatRegistry;
    agents: Agent[];
    endpointResolver: ApiProviderEndpointResolver;
  }) {
    this.#registry = args.registry;
    this.#endpointResolver = args.endpointResolver;
    this.#directory = new AgentDirectory(args.agents);
    this.#catalog = new AgentCatalogService({
      directory: this.#directory,
      endpointResolver: this.#endpointResolver,
    });
  }

  hasAgent(agentId: string): boolean {
    return this.#directory.has(agentId);
  }

  supportsFork(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsFork ?? false;
  }

  supportsImages(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsImages ?? false;
  }

  acceptsApiProviderEndpoints(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.acceptsApiProviderEndpoints ?? false;
  }

  supportedProtocols(agentId: string): ApiProtocol[] {
    return this.#directory.get(agentId)?.capabilities.supportedProtocols ?? [];
  }

  #agentFor(agentId: string): Agent {
    return this.#directory.require(agentId);
  }

  #endpointRuntimeConfig(agent: Agent, selection: ResolvedModelSelection): AgentEndpointRuntimeConfig {
    if (!agent.prepareEndpointRuntime) return {};
    const reference = this.#endpointResolver.resolveEndpointReference(selection);
    if (!reference || !selection.apiProviderId || !selection.endpointId || !selection.protocol) return {};
    return agent.prepareEndpointRuntime({
      model: selection.model,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
      isLocal: selection.isLocal,
      ...reference,
    }) ?? {};
  }

  #setTurnMetadata(chatId: string, opts: { clientRequestId?: string; turnId?: string }): void {
    if (opts.clientRequestId || opts.turnId) {
      this.#turnMetadataByChatId.set(chatId, {
        clientRequestId: opts.clientRequestId,
        turnId: opts.turnId,
      });
      return;
    }
    this.#turnMetadataByChatId.delete(chatId);
  }

  async startSession(chatId: string, command: string, opts: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: ThinkingMode;
    claudeThinkingMode?: ClaudeThinkingMode;
    ampAgentMode?: AmpAgentMode;
    projectPath?: string;
    clientRequestId?: string;
    turnId?: string;
  } = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);

    const maxSessions = getMaxSessions();
    if (maxSessions > 0) {
      const running = this.getRunningSessionCount();
      if (running >= maxSessions) {
        throw new Error(`Session limit reached (${maxSessions}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`);
      }
    }

    const entry = requireChatEntry(chatId, rawEntry);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });

    const agent = this.#agentFor(entry.agentId);
    const runtimeConfig = this.#endpointRuntimeConfig(agent, selection);
    const resolvedCommand = await resolveFileMentionsInCommand(command, entry.projectPath);
    const request: StartSessionRequest = {
      chatId,
      command: resolvedCommand,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode: entry.permissionMode,
      thinkingMode: entry.thinkingMode,
      claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
      clientRequestId: opts.clientRequestId,
      turnId: opts.turnId,
      images: opts.images,
      ...runtimeConfig,
      ...selectionRequestFields(selection),
    };

    this.#setTurnMetadata(chatId, opts);
    let started: StartedAgentSession;
    try {
      started = await agent.runtime.startSession(request);
    } catch (error) {
      this.#turnMetadataByChatId.delete(chatId);
      throw error;
    }
    this.#registry.updateChat(chatId, {
      agentSessionId: started.agentSessionId,
      nativePath: started.nativePath,
      apiProviderId: selection.apiProviderId,
      modelEndpointId: selection.endpointId,
      modelProtocol: selection.protocol,
    });
  }

  async runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { agentId, agentSessionId } = rawEntry;
    if (!agentSessionId) {
      throw new Error(`Session missing agent session ID: ${chatId}`);
    }

    const entry = requireChatEntry(chatId, rawEntry);
    const effectiveModel = opts.model ?? entry.model;

    const previousSelection = this.#endpointResolver.resolveSelection({
      agentId,
      model: entry.model,
      apiProviderId: rawEntry.apiProviderId,
      modelEndpointId: rawEntry.modelEndpointId,
    });

    const nextApiProviderId = opts.apiProviderId !== undefined ? opts.apiProviderId : rawEntry.apiProviderId;
    const nextEndpointId = opts.modelEndpointId !== undefined ? opts.modelEndpointId : rawEntry.modelEndpointId;
    const selection = this.#endpointResolver.resolveSelection({
      agentId,
      model: effectiveModel,
      apiProviderId: nextApiProviderId,
      modelEndpointId: nextEndpointId,
    });

    assertSameApiProviderBoundary(previousSelection, selection);

    const agent = this.#agentFor(agentId);
    const runtimeConfig = this.#endpointRuntimeConfig(agent, selection);
    const resolvedCommand = await resolveFileMentionsInCommand(command, entry.projectPath);
    this.#setTurnMetadata(chatId, opts);
    let startedTurn = false;
    try {
      startedTurn = true;
      await agent.runtime.runTurn({
        chatId,
        agentSessionId,
        command: resolvedCommand,
        projectPath: entry.projectPath,
        model: selection.model,
        permissionMode: opts.permissionMode ?? entry.permissionMode,
        thinkingMode: opts.thinkingMode ?? entry.thinkingMode,
        claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
        clientRequestId: opts.clientRequestId,
        turnId: opts.turnId,
        images: opts.images,
        nativePath: rawEntry.nativePath,
        ...runtimeConfig,
        ...selectionRequestFields(selection),
      });
    } catch (error) {
      if (startedTurn) this.#turnMetadataByChatId.delete(chatId);
      throw error;
    }
  }

  async abortSession(chatId: string): Promise<boolean> {
    const entry = this.#registry.getChat(chatId);
    const agentSessionId = entry?.agentSessionId;
    if (!agentSessionId) return false;
    const agent = this.#directory.get(entry.agentId);
    if (!agent) return false;
    return agent.runtime.abort(agentSessionId);
  }

  isChatRunning(chatId: string): boolean {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return false;
    return this.isAgentSessionRunning(entry.agentId, entry.agentSessionId);
  }

  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean {
    if (!agentSessionId) return false;
    const agent = this.#directory.get(agentId);
    if (!agent) return false;
    return agent.runtime.isRunning(agentSessionId);
  }

  getRunningSessions(): Record<string, Array<{ id: string;[key: string]: unknown }>> {
    const mapToChatId = (arr: Array<{ id: string;[key: string]: unknown }>) =>
      arr
        .map((e) => (typeof e === 'string' ? { id: e } : e))
        .map((e) => {
          const match = e?.id ? this.#registry.getChatByAgentSessionId(e.id) : null;
          const mapped = match ? match[0] : null;
          return mapped ? { ...e, id: mapped } : null;
        })
        .filter((e): e is NonNullable<typeof e> => Boolean(e));

    const result: Record<string, Array<{ id: string;[key: string]: unknown }>> = {};
    for (const agent of this.#directory.list()) {
      result[agent.id] = mapToChatId(agent.runtime.getRunningSessions());
    }
    return result;
  }

  getRunningSessionCount(): number {
    let total = 0;
    for (const agent of this.#directory.list()) {
      total += agent.runtime.getRunningSessions().length;
    }
    return total;
  }

  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
    if (!chatId || !permissionRequestId) return;

    const chat = this.#registry.getChat(chatId);
    if (!chat) {
      console.warn('agents: resolvePermission, unknown chatId:', chatId);
      return;
    }

    const agent = this.#directory.get(chat.agentId);
    if (agent?.runtime.resolvePermission) {
      Promise.resolve(agent.runtime.resolvePermission(permissionRequestId, decision)).catch((err: Error) => {
        console.warn(`agents: ${chat.agentId} permission reply failed:`, err.message);
      });
      return;
    }

    console.warn('agents: no permission handler for agent:', chat.agentId);
  }

  async forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
  }): Promise<StartedAgentSession | null> {
    const agent = this.#directory.get(args.sourceSession.agentId);
    if (!agent?.forkSession) return null;
    const source = requireChatEntry(args.sourceChatId, args.sourceSession);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: source.agentId,
      model: source.model,
      apiProviderId: source.apiProviderId,
      modelEndpointId: source.modelEndpointId,
    });
    const runtimeConfig = this.#endpointRuntimeConfig(agent, selection);
    return agent.forkSession({
      ...args,
      sourceSession: {
        ...source,
        model: selection.model,
        ...selectionRequestFields(selection),
      },
      ...runtimeConfig,
    });
  }

  async updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry> {
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

  async runSingleQuery(prompt: string, options: { agentId?: string;[key: string]: unknown } = {}): Promise<string> {
    const { agentId = 'claude', ...rest } = options;
    const agent = this.#directory.get(agentId);
    if (agent?.runSingleQuery) {
      const model = typeof rest.model === 'string' ? rest.model : '';
      if (model) {
        const selection = this.#endpointResolver.resolveSelection({
          agentId,
          model,
          apiProviderId: typeof rest.apiProviderId === 'string' ? rest.apiProviderId : null,
          modelEndpointId: typeof rest.modelEndpointId === 'string' ? rest.modelEndpointId : null,
        });
        rest.model = selection.model;
        mergeRuntimeConfig(rest, this.#endpointRuntimeConfig(agent, selection));
        Object.assign(rest, selectionRequestFields(selection));
      }
      return agent.runSingleQuery(prompt, rest);
    }
    throw new Error(`Single query unsupported for agent: ${agentId}`);
  }

  async getPreview(session: AgentChatEntry | null): Promise<unknown> {
    if (!session?.agentId) return null;
    const agent = this.#directory.get(session.agentId);
    if (!agent?.transcript.getPreview) return null;
    return agent.transcript.getPreview(session);
  }

  async loadMessages(session: AgentChatEntry | null, chatId?: string): Promise<unknown[]> {
    if (!session?.agentId) return [];
    const agent = this.#directory.get(session.agentId);
    if (!agent) return [];
    return agent.transcript.loadMessages(session, { chatId });
  }

  async getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    return this.#catalog.getModels(agentId, query);
  }

  async modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    return this.#catalog.modelSupportsImages(input);
  }

  async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;
    const agent = this.#directory.get(session.agentId);
    if (!agent?.transcript.resolveNativePath) return null;
    return agent.transcript.resolveNativePath(session);
  }

  async launchAgentAuthLogin(agentId: string): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code: string };
  }> {
    const agent = this.#directory.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    if (!agent.capabilities.authLoginSupported || !agent.auth.launchLogin) {
      throw new Error(`Auth login is not supported for agent: ${agentId}`);
    }
    return agent.auth.launchLogin();
  }

  async getAgentAuthStatus(agentId: string): Promise<unknown | null> {
    const agent = this.#directory.get(agentId);
    if (!agent) return null;
    return agent.auth.getAuthStatus();
  }

  async getAgentAuthStatusMap(): Promise<Record<string, unknown>> {
    const authEntries = await Promise.all(
      this.#directory.list().map(async (agent) => [agent.id, await agent.auth.getAuthStatus()] as const),
    );
    return Object.fromEntries(authEntries);
  }

  async getAgentReadinessMap(): Promise<Record<string, {
    ready: boolean;
    nativeReady: boolean;
    endpointReady: boolean;
    reason: string;
  }>> {
    const auth = await this.getAgentAuthStatusMap();
    const result: Record<string, { ready: boolean; nativeReady: boolean; endpointReady: boolean; reason: string }> = {};
    for (const agent of this.#directory.list()) {
      const agentId = agent.id;
      if (!isVisibleAgentId(agentId)) continue;
      const endpointReady = agent.capabilities.acceptsApiProviderEndpoints
        && this.#catalog.hasEndpointModels(agentId);
      const nativeReady = Boolean((auth[agentId] as any)?.authenticated);
      result[agentId] = {
        ready: nativeReady || endpointReady,
        nativeReady,
        endpointReady,
        reason: endpointReady
          ? 'At least one compatible API provider endpoint is configured.'
          : nativeReady
            ? 'Native agent authentication is available.'
            : 'No native authentication or compatible API provider endpoint is configured.',
      };
    }
    return result;
  }

  startPurgeTimers(): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.startPurgeTimer?.();
    }
  }

  shutdown(): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.shutdown?.();
    }
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onMessages((chatId, messages, eventMetadata) => {
        cb(chatId, messages, mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata));
      });
    }
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onProcessing(cb);
    }
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onSessionCreated(cb);
    }
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFinished((chatId, exitCode, eventMetadata) => {
        const metadata = mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata);
        cb(chatId, exitCode, metadata);
        this.#turnMetadataByChatId.delete(chatId);
      });
    }
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFailed((chatId, errorMessage) => {
        const metadata = this.#turnMetadataByChatId.get(chatId);
        cb(chatId, errorMessage, metadata);
        this.#turnMetadataByChatId.delete(chatId);
      });
    }
  }

  async getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}): Promise<AgentCatalogEntry | null> {
    return this.#catalog.getAgentCatalogEntry(agentId, query);
  }

  async getAgentCatalogEntries(): Promise<AgentCatalogEntry[]> {
    return this.#catalog.getAgentCatalogEntries();
  }

}

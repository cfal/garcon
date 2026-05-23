// Unified agent registry. Routes all operations through agent runtimes
// keyed by agent ID. Also provides preview/message loading, agent auth,
// readiness, and model catalog metadata.

import { resolveFileMentionsInCommand } from "../chats/file-mentions.ts";
import { getMaxSessions } from "../config.js";
import type { IChatRegistry } from "../chats/store.js";

import type { AgentCommandImage } from "../../common/ws-requests.js";
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from "../../common/chat-modes.js";
import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS, PI_MODELS } from "../../common/models.js";
import type {
  AgentChatEntry,
  AgentEventMetadata,
  StartSessionRequest,
  StartedAgentSession,
  RunAgentTurnOptions,
} from "./session-types.js";
import { requireChatExecutionConfig } from "./session-types.js";
import type { ApiProviderEndpointResolver, ResolvedModelSelection } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type { Agent } from './types.js';
import {
  isEndpointOnlyAgentId,
  isVisibleAgentId,
  type AgentId,
  type AgentCatalogEntry,
  type AgentModelOption,
} from "../../common/agents.js";
import type { ApiProtocol } from "../../common/api-providers.js";
import type { AgentModelQuery } from './types.js';
const STATIC_AGENT_MODELS: Record<string, { defaultModel: string; models: AgentModelOption[] }> = {
  claude: { defaultModel: CLAUDE_MODELS.DEFAULT, models: CLAUDE_MODELS.OPTIONS },
  codex: { defaultModel: CODEX_MODELS.DEFAULT, models: CODEX_MODELS.OPTIONS },
  amp: { defaultModel: AMP_MODELS.DEFAULT, models: AMP_MODELS.OPTIONS },
  factory: { defaultModel: FACTORY_MODELS.DEFAULT, models: FACTORY_MODELS.OPTIONS },
  pi: { defaultModel: PI_MODELS.DEFAULT, models: PI_MODELS.OPTIONS },
};

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

function dedupeModels(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const result: AgentModelOption[] = [];
  for (const model of models) {
    if (!model.value || seen.has(model.value)) continue;
    seen.add(model.value);
    result.push(model);
  }
  return result;
}

async function nativeModelsForAgent(id: string, agent: Agent, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
  let fetched: AgentModelOption[] = [];
  const getModels = agent.capabilities.getModels;
  if (!isEndpointOnlyAgentId(id) && getModels) {
    try {
      fetched = await getModels(query);
    } catch (error) {
      if (query.strict) throw error;
      console.warn(`agents: failed to fetch ${id} models:`, error instanceof Error ? error.message : String(error));
    }
  }
  const fallback = STATIC_AGENT_MODELS[id]?.models ?? [];
  return dedupeModels([...fetched, ...fallback]);
}

function defaultModelForAgent(id: string, nativeModels: AgentModelOption[], endpointModels: AgentModelOption[]): string {
  const fallbackDefault = STATIC_AGENT_MODELS[id]?.defaultModel;
  if (fallbackDefault && nativeModels.some((model) => model.value === fallbackDefault)) {
    return fallbackDefault;
  }
  return nativeModels[0]?.value ?? endpointModels[0]?.value ?? fallbackDefault ?? '';
}

interface TurnEventMetadata {
  clientRequestId?: string;
  providerRequestId?: string;
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

export class AgentRegistry {
  #registry: IChatRegistry;
  #agents = new Map<string, Agent>();
  #endpointResolver: ApiProviderEndpointResolver;
  #turnMetadataByChatId = new Map<string, TurnEventMetadata>();

  constructor(args: {
    registry: IChatRegistry;
    agents: Agent[];
    endpointResolver: ApiProviderEndpointResolver;
  }) {
    this.#registry = args.registry;
    this.#endpointResolver = args.endpointResolver;

    for (const agent of args.agents) {
      this.#agents.set(agent.id, agent);
    }
  }

  hasAgent(agentId: string): boolean {
    return this.#agents.has(agentId);
  }

  supportsFork(agentId: string): boolean {
    return this.#agents.get(agentId)?.capabilities.supportsFork ?? false;
  }

  supportsImages(agentId: string): boolean {
    return this.#agents.get(agentId)?.capabilities.supportsImages ?? false;
  }

  acceptsApiProviderEndpoints(agentId: string): boolean {
    return this.#agents.get(agentId)?.capabilities.acceptsApiProviderEndpoints ?? false;
  }

  supportedProtocols(agentId: string): ApiProtocol[] {
    return this.#agents.get(agentId)?.capabilities.supportedProtocols ?? [];
  }

  #agentFor(agentId: string): Agent {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    return agent;
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
      envOverrides: selection.envOverrides,
      ...(selection.codexConfig ? { codexConfig: selection.codexConfig } : {}),
      ...selectionRequestFields(selection),
    };

    const agent = this.#agentFor(entry.agentId);
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
        envOverrides: selection.envOverrides,
        nativePath: rawEntry.nativePath,
        ...(selection.codexConfig ? { codexConfig: selection.codexConfig } : {}),
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
    const agent = this.#agents.get(entry.agentId);
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
    const agent = this.#agents.get(agentId);
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
    for (const [agentId, agent] of this.#agents.entries()) {
      result[agentId] = mapToChatId(agent.runtime.getRunningSessions());
    }
    return result;
  }

  getRunningSessionCount(): number {
    let total = 0;
    for (const agent of this.#agents.values()) {
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

    const agent = this.#agents.get(chat.agentId);
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
    const agent = this.#agents.get(args.sourceSession.agentId);
    if (!agent?.forkSession) return null;
    const source = requireChatEntry(args.sourceChatId, args.sourceSession);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: source.agentId,
      model: source.model,
      apiProviderId: source.apiProviderId,
      modelEndpointId: source.modelEndpointId,
    });
    return agent.forkSession({
      ...args,
      sourceSession: {
        ...source,
        model: selection.model,
        ...selectionRequestFields(selection),
      },
      envOverrides: selection.envOverrides,
      ...(selection.codexConfig ? { codexConfig: selection.codexConfig } : {}),
    });
  }

  async setPermissionMode(chatId: string, mode: PermissionMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const agentSessionId = entry?.agentSessionId;
    if (!agentSessionId) return;
    await this.#agents.get(entry.agentId)?.runtime.setPermissionMode?.(agentSessionId, mode);
  }

  async setThinkingMode(chatId: string, mode: ThinkingMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const agentSessionId = entry?.agentSessionId;
    if (!agentSessionId) return;
    await this.#agents.get(entry.agentId)?.runtime.setThinkingMode?.(agentSessionId, mode);
  }

  async setClaudeThinkingMode(chatId: string, mode: ClaudeThinkingMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const agentSessionId = entry?.agentSessionId;
    if (!agentSessionId) return;
    await this.#agents.get(entry.agentId)?.runtime.setClaudeThinkingMode?.(agentSessionId, mode);
  }

  async setAmpAgentMode(chatId: string, mode: AmpAgentMode): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const agentSessionId = entry?.agentSessionId;
    if (!agentSessionId) return;
    await this.#agents.get(entry.agentId)?.runtime.setAmpAgentMode?.(agentSessionId, mode);
  }

  async setModel(chatId: string, model: string, metadata: {
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  } = {}): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return;
    const previous = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    const next = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model,
      apiProviderId: metadata.apiProviderId !== undefined ? metadata.apiProviderId : entry.apiProviderId,
      modelEndpointId: metadata.modelEndpointId !== undefined ? metadata.modelEndpointId : entry.modelEndpointId,
    });
    assertSameApiProviderBoundary(previous, next);
  }

  async runSingleQuery(prompt: string, options: { agentId?: string;[key: string]: unknown } = {}): Promise<string> {
    const { agentId = 'claude', ...rest } = options;
    const agent = this.#agents.get(agentId);
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
        if (selection.envOverrides) rest.envOverrides = selection.envOverrides;
        if (selection.codexConfig) rest.codexConfig = selection.codexConfig;
        Object.assign(rest, selectionRequestFields(selection));
      }
      return agent.runSingleQuery(prompt, rest);
    }
    throw new Error(`Single query unsupported for agent: ${agentId}`);
  }

  async getPreview(session: AgentChatEntry | null): Promise<unknown> {
    if (!session?.agentId) return null;
    const agent = this.#agents.get(session.agentId);
    if (!agent?.transcript.getPreview) return null;
    return agent.transcript.getPreview(session);
  }

  async loadMessages(session: AgentChatEntry | null, chatId?: string): Promise<unknown[]> {
    if (!session?.agentId) return [];
    const agent = this.#agents.get(session.agentId);
    if (!agent) return [];
    return agent.transcript.loadMessages(session, { chatId });
  }

  async getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    const getModels = this.#agents.get(agentId)?.capabilities.getModels;
    if (getModels) return getModels(query);
    return [];
  }

  async modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    return this.#endpointResolver.modelSupportsImages({
      agentId: input.agentId as AgentId,
      model: input.model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
    });
  }

  async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;
    const agent = this.#agents.get(session.agentId);
    if (!agent?.transcript.resolveNativePath) return null;
    return agent.transcript.resolveNativePath(session);
  }

  async launchAgentAuthLogin(agentId: string): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code: string };
  }> {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    if (!agent.capabilities.authLoginSupported || !agent.auth.launchLogin) {
      throw new Error(`Auth login is not supported for agent: ${agentId}`);
    }
    return agent.auth.launchLogin();
  }

  async getAgentAuthStatus(agentId: string): Promise<unknown | null> {
    const agent = this.#agents.get(agentId);
    if (!agent) return null;
    return agent.auth.getAuthStatus();
  }

  async getAgentAuthStatusMap(): Promise<Record<string, unknown>> {
    const authEntries = await Promise.all(
      Array.from(this.#agents.values()).map(async (agent) => [agent.id, await agent.auth.getAuthStatus()] as const),
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
    for (const [agentId, agent] of this.#agents.entries()) {
      if (!isVisibleAgentId(agentId)) continue;
      const endpointReady = agent.capabilities.acceptsApiProviderEndpoints
        && this.#endpointResolver.getModelOptions(agentId as AgentId).length > 0;
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
    for (const agent of this.#agents.values()) {
      agent.runtime.startPurgeTimer?.();
    }
  }

  shutdown(): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.shutdown?.();
    }
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.onMessages((chatId, messages, eventMetadata) => {
        cb(chatId, messages, mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata));
      });
    }
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.onProcessing(cb);
    }
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.onSessionCreated(cb);
    }
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.onFinished((chatId, exitCode, eventMetadata) => {
        const metadata = mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata);
        cb(chatId, exitCode, metadata);
        this.#turnMetadataByChatId.delete(chatId);
      });
    }
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#agents.values()) {
      agent.runtime.onFailed((chatId, errorMessage) => {
        const metadata = this.#turnMetadataByChatId.get(chatId);
        cb(chatId, errorMessage, metadata);
        this.#turnMetadataByChatId.delete(chatId);
      });
    }
  }

  async getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}): Promise<AgentCatalogEntry | null> {
    const agent = this.#agents.get(agentId);
    if (!agent || !isVisibleAgentId(agentId)) return null;
    const endpointModels = this.#endpointResolver.getModelOptions(agentId as AgentId);
    const nativeModels = await nativeModelsForAgent(agentId, agent, query);
    const models = isEndpointOnlyAgentId(agentId)
      ? dedupeModels(endpointModels)
      : dedupeModels([...nativeModels, ...endpointModels]);
    return {
      id: agentId as AgentId,
      label: agent.label,
      kind: 'agent',
      supportsFork: agent.capabilities.supportsFork,
      supportsImages: agent.capabilities.supportsImages,
      acceptsApiProviderEndpoints: agent.capabilities.acceptsApiProviderEndpoints,
      supportedProtocols: agent.capabilities.supportedProtocols,
      authLoginSupported: agent.capabilities.authLoginSupported,
      defaultModel: defaultModelForAgent(agentId, nativeModels, endpointModels),
      models,
    };
  }

  async getAgentCatalogEntries(): Promise<AgentCatalogEntry[]> {
    return (await Promise.all(Array.from(this.#agents.keys()).map((id) => this.getAgentCatalogEntry(id))))
      .filter((entry): entry is AgentCatalogEntry => Boolean(entry));
  }

}

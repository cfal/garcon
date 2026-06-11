import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { getMaxSessions } from '../config.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type { AgentCommandImage } from '../../common/ws-requests.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '../../common/chat-modes.js';
import type {
  AgentChatEntry,
  RunAgentTurnOptions,
  StartSessionRequest,
  StartedAgentSession,
} from './session-types.js';
import type { AgentDirectory } from './directory.js';
import type { AgentEventBus } from './event-bus.js';
import {
  endpointRuntimeConfig,
  mergeRuntimeConfig,
  requireAgentChatEntry,
  selectionRequestFields,
} from './execution-planning.js';

export class AgentRuntimeRouter {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #events: AgentEventBus;

  constructor(args: {
    registry: IChatRegistry;
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
    events: AgentEventBus;
  }) {
    this.#registry = args.registry;
    this.#directory = args.directory;
    this.#endpointResolver = args.endpointResolver;
    this.#events = args.events;
  }

  #getEndpointRuntimeConfig(agentId: string, selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>) {
    return endpointRuntimeConfig(
      this.#directory.require(agentId),
      this.#endpointResolver,
      selection,
    );
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

    const entry = requireAgentChatEntry(chatId, rawEntry);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });

    const agent = this.#directory.require(entry.agentId);
    const runtimeConfig = this.#getEndpointRuntimeConfig(entry.agentId, selection);
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

    this.#events.trackTurn(chatId, { ...opts, commandType: 'chat-start' });
    let started: StartedAgentSession;
    try {
      started = await agent.runtime.startSession(request);
    } catch (error) {
      this.#events.clearTurn(chatId);
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

    const entry = requireAgentChatEntry(chatId, rawEntry);
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

    const agent = this.#directory.require(agentId);
    const runtimeConfig = this.#getEndpointRuntimeConfig(agentId, selection);
    const resolvedCommand = await resolveFileMentionsInCommand(command, entry.projectPath);
    this.#events.trackTurn(chatId, opts);
    try {
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
      this.#events.clearTurn(chatId);
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
    const source = requireAgentChatEntry(args.sourceChatId, args.sourceSession);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: source.agentId,
      model: source.model,
      apiProviderId: source.apiProviderId,
      modelEndpointId: source.modelEndpointId,
    });
    const runtimeConfig = endpointRuntimeConfig(agent, this.#endpointResolver, selection);
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
        mergeRuntimeConfig(rest, endpointRuntimeConfig(agent, this.#endpointResolver, selection));
        Object.assign(rest, selectionRequestFields(selection));
      }
      return agent.runSingleQuery(prompt, rest);
    }
    throw new Error(`Single query unsupported for agent: ${agentId}`);
  }
}

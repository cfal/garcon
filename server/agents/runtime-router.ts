import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { getMaxSessions } from '../config.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import type { AgentCommandImage } from '../../common/ws-requests.js';
import { DEFAULT_AGENT_ID } from '../../common/agents.js';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { SlashCommand } from '../../common/slash-commands.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '../../common/chat-modes.js';
import { normalizeThinkingModeForAgent } from '../../common/chat-modes.js';
import type {
  AgentChatEntry,
  AgentExecutionCommandType,
  AgentExecutionAdmission,
  PrepareProjectPathUpdateRequest,
  ResumeTurnRequest,
  RunAgentTurnOptions,
  StartSessionRequest,
  StartedAgentSession,
} from './session-types.js';
import { assertExecutionAdmissionOpen } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import type { AgentEventBus } from './event-bus.js';
import { createLogger } from '../lib/log.js';
import { parseCodexGoalCommand, type CodexGoalCommand } from './goal-command.js';
import {
  endpointRuntimeConfig,
  mergeRuntimeConfig,
  requireAgentChatEntry,
  selectionRequestFields,
} from './execution-planning.js';

const logger = createLogger('agents:runtime-router');

interface PreparedAgentCommand {
  command: string;
  codexGoalCommand?: CodexGoalCommand;
}

function prepareAgentCommand(agentId: string, command: string): PreparedAgentCommand {
  if (agentId !== 'codex') return { command };
  const parsed = parseCodexGoalCommand(command);
  if (!parsed) return { command };
  if (hasGoalObjective(parsed)) return { command: parsed.objective, codexGoalCommand: parsed };
  return { command, codexGoalCommand: parsed };
}

function hasGoalObjective(command: CodexGoalCommand): command is Extract<CodexGoalCommand, { objective: string }> {
  return 'objective' in command && typeof command.objective === 'string';
}

function withResolvedGoalObjective(
  command: CodexGoalCommand | undefined,
  resolvedCommand: string,
): CodexGoalCommand | undefined {
  return command && hasGoalObjective(command) ? { ...command, objective: resolvedCommand } : command;
}

function assertCanStartCodexGoalCommand(command: CodexGoalCommand | undefined): void {
  if (!command || command.kind === 'set') return;
  throw new Error('Start a Codex session with /goal <objective> before using goal controls.');
}

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
    clientMessageId?: string;
    turnId?: string;
    commandType?: AgentExecutionCommandType;
    executionAdmission?: AgentExecutionAdmission;
    codexGoalCommand?: CodexGoalCommand;
    codexSeedContext?: string;
    // Skips @-mention resolution when the command is already resolved (e.g. a
    // seeded cross-agent continuation, whose historical text must stay opaque).
    skipFileMentions?: boolean;
  } = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
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
    const prepared = opts.codexGoalCommand
      ? { command, codexGoalCommand: opts.codexGoalCommand }
      : prepareAgentCommand(entry.agentId, command);
    assertCanStartCodexGoalCommand(prepared.codexGoalCommand);
    const resolvedCommand = opts.skipFileMentions
      ? prepared.command
      : await resolveFileMentionsInCommand(prepared.command, entry.projectPath);
    assertExecutionAdmissionOpen(opts);
    let started: StartedAgentSession | null = null;
    let registryBound = false;
    let runtimeAbortable = false;
    let abortabilityPublished = false;
    const commandType = opts.commandType ?? 'chat-start';
    const publishAbortability = () => {
      if (
        abortabilityPublished
        || !runtimeAbortable
        || !registryBound
        || !started
        || !agent.runtime.isRunning(started.agentSessionId)
      ) {
        return;
      }
      abortabilityPublished = true;
      this.#events.markTurnAbortable(chatId, {
        clientRequestId: opts.clientRequestId,
        commandType,
        turnId: opts.turnId,
      });
    };
    const request: StartSessionRequest = {
      chatId,
      command: resolvedCommand,
      codexGoalCommand: opts.codexGoalCommand
        ?? withResolvedGoalObjective(prepared.codexGoalCommand, resolvedCommand),
      codexSeedContext: opts.codexSeedContext,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode: entry.permissionMode,
      thinkingMode: normalizeThinkingModeForAgent(entry.agentId, entry.thinkingMode),
      claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
      clientRequestId: opts.clientRequestId,
      clientMessageId: opts.clientMessageId,
      turnId: opts.turnId,
      executionAdmission: opts.executionAdmission,
      images: opts.images,
      onAbortable: () => {
        runtimeAbortable = true;
        publishAbortability();
      },
      ...runtimeConfig,
      ...selectionRequestFields(selection),
    };

    this.#events.trackTurn(chatId, { ...opts, commandType });
    try {
      started = await agent.runtime.startSession(request);
      assertExecutionAdmissionOpen(opts);
      const updated = await this.#registry.updateChat(chatId, {
        agentSessionId: started.agentSessionId,
        nativePath: started.nativePath,
        apiProviderId: selection.apiProviderId,
        modelEndpointId: selection.endpointId,
        modelProtocol: selection.protocol,
      }, { flush: true });
      if (!updated) {
        throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
      }
      registryBound = true;
      publishAbortability();
    } catch (error) {
      this.#events.clearTurn(chatId);
      if (started) {
        try {
          await agent.runtime.abort(started.agentSessionId);
        } catch (abortError) {
          logger.warn(
            `agents: failed to abort ${entry.agentId} session after registry bind failure:`,
            abortError instanceof Error ? abortError.message : String(abortError),
          );
        }
      }
      throw error;
    }
  }

  async runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { agentId, agentSessionId } = rawEntry;
    if (!agentSessionId) {
      // A cross-agent switch leaves no native session but stages seed text so the
      // first turn resumes the prior conversation under the new agent.
      if (rawEntry.carryOverContext) {
        const prepared = prepareAgentCommand(agentId, command);
        // Resolve @-mentions on the user's message only; the seed is historical
        // transcript text and must stay opaque so it cannot re-inject file
        // contents into the fresh session.
        const resolvedCommand = await resolveFileMentionsInCommand(prepared.command, rawEntry.projectPath);
        const codexGoalCommand = withResolvedGoalObjective(prepared.codexGoalCommand, resolvedCommand);
        const injectCodexSeed = agentId === 'codex' && Boolean(codexGoalCommand);
        const seededCommand = injectCodexSeed
          ? resolvedCommand
          : `${rawEntry.carryOverContext}\n\n${resolvedCommand}`;
        await this.startSession(chatId, seededCommand, {
          images: opts.images,
          model: opts.model,
          permissionMode: opts.permissionMode,
          thinkingMode: opts.thinkingMode,
          claudeThinkingMode: opts.claudeThinkingMode,
          ampAgentMode: opts.ampAgentMode,
          clientRequestId: opts.clientRequestId,
          clientMessageId: opts.clientMessageId,
          turnId: opts.turnId,
          commandType: opts.commandType,
          executionAdmission: opts.executionAdmission,
          codexGoalCommand,
          codexSeedContext: injectCodexSeed ? rawEntry.carryOverContext : undefined,
          skipFileMentions: true,
        });
        await this.#registry.updateChat(chatId, { carryOverContext: null }, { flush: true });
        return;
      }
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
    const prepared = prepareAgentCommand(agentId, command);
    const resolvedCommand = await resolveFileMentionsInCommand(prepared.command, entry.projectPath);
    assertExecutionAdmissionOpen(opts);
    this.#events.trackTurn(chatId, opts);
    try {
      await agent.runtime.runTurn({
        chatId,
        agentSessionId,
        command: resolvedCommand,
        codexGoalCommand: withResolvedGoalObjective(prepared.codexGoalCommand, resolvedCommand),
        projectPath: entry.projectPath,
        model: selection.model,
        permissionMode: opts.permissionMode ?? entry.permissionMode,
        thinkingMode: normalizeThinkingModeForAgent(agentId, opts.thinkingMode ?? entry.thinkingMode),
        claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
        clientRequestId: opts.clientRequestId,
        clientMessageId: opts.clientMessageId,
        turnId: opts.turnId,
        executionAdmission: opts.executionAdmission,
        images: opts.images,
        nativePath: rawEntry.nativePath,
        onAbortable: () => this.#events.markTurnAbortable(chatId, {
          clientRequestId: opts.clientRequestId,
          turnId: opts.turnId,
        }),
        ...runtimeConfig,
        ...selectionRequestFields(selection),
      });
    } catch (error) {
      this.#events.clearTurn(chatId);
      throw error;
    }
  }

  async submitActiveInput(
    chatId: string,
    command: string,
    opts: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean> {
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry?.agentSessionId) return false;
    const entry = requireAgentChatEntry(chatId, rawEntry);
    const agent = this.#directory.require(entry.agentId);
    if (!agent.runtime.submitActiveInput) return false;
    const prepared = prepareAgentCommand(entry.agentId, command);
    const resolvedCommand = await resolveFileMentionsInCommand(prepared.command, entry.projectPath);
    return agent.runtime.submitActiveInput({
      chatId,
      agentSessionId: rawEntry.agentSessionId,
      command: resolvedCommand,
      codexGoalCommand: withResolvedGoalObjective(prepared.codexGoalCommand, resolvedCommand),
      projectPath: entry.projectPath,
      model: opts.model ?? entry.model,
      permissionMode: opts.permissionMode ?? entry.permissionMode,
      thinkingMode: normalizeThinkingModeForAgent(entry.agentId, opts.thinkingMode ?? entry.thinkingMode),
      claudeThinkingMode: opts.claudeThinkingMode ?? entry.claudeThinkingMode,
      clientRequestId: opts.clientRequestId,
      clientMessageId: opts.clientMessageId,
      turnId: opts.turnId,
      images: opts.images,
      nativePath: rawEntry.nativePath,
    }, beforeDelivery);
  }

  // Triggers context compaction for a chat. Agents with a dedicated mechanism
  // implement runtime.compact(); the rest fall back to running a `/compact` turn.
  async compactSession(chatId: string, opts: {
    instructions?: string;
    clientRequestId?: string;
    turnId?: string;
    executionAdmission?: AgentExecutionAdmission;
  } = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { agentId, agentSessionId } = rawEntry;
    if (!agentSessionId) {
      throw new Error(`Session missing agent session ID: ${chatId}`);
    }

    const entry = requireAgentChatEntry(chatId, rawEntry);
    const selection = this.#endpointResolver.resolveSelection({
      agentId,
      model: entry.model,
      apiProviderId: rawEntry.apiProviderId,
      modelEndpointId: rawEntry.modelEndpointId,
    });

    const agent = this.#directory.require(agentId);
    const runtimeConfig = this.#getEndpointRuntimeConfig(agentId, selection);
    const instructions = opts.instructions?.trim();
    const request: ResumeTurnRequest = {
      chatId,
      agentSessionId,
      command: instructions ? `/compact ${instructions}` : '/compact',
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode: entry.permissionMode,
      thinkingMode: normalizeThinkingModeForAgent(agentId, entry.thinkingMode),
      claudeThinkingMode: entry.claudeThinkingMode,
      clientRequestId: opts.clientRequestId,
      turnId: opts.turnId,
      executionAdmission: opts.executionAdmission,
      nativePath: rawEntry.nativePath,
      onAbortable: () => this.#events.markTurnAbortable(chatId, {
        clientRequestId: opts.clientRequestId,
        turnId: opts.turnId,
      }),
      ...runtimeConfig,
      ...selectionRequestFields(selection),
    };

    this.#events.trackTurn(chatId, {
      clientRequestId: opts.clientRequestId,
      commandType: 'agent-compact',
      turnId: opts.turnId,
    });
    logger.info(`compact: dispatching chat=${chatId} agent=${agentId} native=${typeof agent.runtime.compact === 'function' ? 'compact()' : 'runTurn(/compact)'}`);
    try {
      if (agent.runtime.compact) {
        await agent.runtime.compact(request);
      } else {
        await agent.runtime.runTurn(request);
      }
    } catch (error) {
      this.#events.clearTurn(chatId);
      throw error;
    }
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<void> {
    const agent = this.#directory.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    await agent.runtime.prepareProjectPathUpdate?.(request);
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

  getRunningChatIdsSnapshot(): string[] {
    const chatIds = new Set<string>();
    let unmappedSessionCount = 0;
    let oldestUnmappedStartedAt: number | null = null;

    for (const agent of this.#directory.list()) {
      const sessions = agent.runtime.getRunningSessions();
      if (!Array.isArray(sessions)) {
        throw new Error(`Running sessions for ${agent.id} are not an array`);
      }

      for (const session of sessions) {
        const agentSessionId = session && typeof session.id === 'string'
          ? session.id.trim()
          : '';
        if (!agentSessionId) {
          throw new Error(`Running session for ${agent.id} has no ID`);
        }

        const match = this.#registry.getChatByAgentSessionId(agentSessionId);
        if (!match) {
          unmappedSessionCount += 1;
          const startedAt = typeof session.startedAt === 'string'
            ? Date.parse(session.startedAt)
            : Number.NaN;
          if (
            Number.isFinite(startedAt)
            && (oldestUnmappedStartedAt === null || startedAt < oldestUnmappedStartedAt)
          ) {
            oldestUnmappedStartedAt = startedAt;
          }
          continue;
        }
        chatIds.add(match[0]);
      }
    }

    if (unmappedSessionCount > 0) {
      const oldestAge = oldestUnmappedStartedAt === null
        ? 'unknown'
        : `${Math.max(0, Math.floor((Date.now() - oldestUnmappedStartedAt) / 1000))}s`;
      throw new Error(
        `Running chat snapshot has ${unmappedSessionCount} unmapped session(s) (oldest age ${oldestAge})`,
      );
    }

    return [...chatIds].sort();
  }

  getRunningSessionCount(): number {
    let total = 0;
    for (const agent of this.#directory.list()) {
      total += agent.runtime.getRunningSessions().length;
    }
    return total;
  }

  resolvePermission(chatId: string, permissionRequestId: string, decision: PermissionDecisionPayload): void {
    if (!chatId || !permissionRequestId) return;

    const chat = this.#registry.getChat(chatId);
    if (!chat) {
      logger.warn('agents: resolvePermission, unknown chatId:', chatId);
      return;
    }

    const agent = this.#directory.get(chat.agentId);
    if (agent?.runtime.resolvePermission) {
      Promise.resolve(agent.runtime.resolvePermission(permissionRequestId, decision)).catch((err: Error) => {
        logger.warn(`agents: ${chat.agentId} permission reply failed:`, err.message);
      });
      return;
    }

    logger.warn('agents: no permission handler for agent:', chat.agentId);
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
    const { agentId = DEFAULT_AGENT_ID, ...rest } = options;
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

  async discoverSlashCommands(agentId: string, projectPath: string): Promise<SlashCommand[]> {
    const agent = this.#directory.get(agentId);
    if (!agent?.discoverSlashCommands) return [];
    return agent.discoverSlashCommands(projectPath);
  }
}

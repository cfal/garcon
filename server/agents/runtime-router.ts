import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevisions,
  type AgentExecutionContext,
  type AgentOperationIdentity,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type ThinkingMode,
} from '../../common/chat-modes.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { getMaxSessions } from '../config.js';
import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { createLogger } from '../lib/log.js';
import { DomainError } from '../lib/domain-error.js';
import type { AgentDirectory } from './directory.js';
import type { AgentEventBus } from './event-bus.js';
import type {
  AgentChatEntry,
  AgentExecutionAdmission,
  AgentExecutionCommandType,
  PrepareProjectPathUpdateRequest,
  RunAgentTurnOptions,
  StartedAgentSession,
} from './session-types.js';
import { assertExecutionAdmissionOpen } from './session-types.js';
import { requireAgentChatEntry, toAgentEndpointSelection } from './execution-planning.js';
import { toAgentChatReference } from './integration-chat-reference.js';

const logger = createLogger('agents:runtime-router');

export interface AgentRuntimeRouterOptions {
  registry: IChatRegistry;
  directory: AgentDirectory;
  endpointResolver: ApiProviderEndpointResolver;
  events: AgentEventBus;
  getCarryOverRevision(chatId: string): string;
  loadCarryOver(chatId: string, entry: AgentChatEntry): readonly ChatMessage[];
}

export interface RunSingleQueryOptions {
  readonly agentId: string;
  readonly model?: string;
  readonly projectPath?: string;
  readonly cwd?: string;
  readonly thinkingMode?: ThinkingMode;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly apiProviderId?: string | null;
  readonly modelEndpointId?: string | null;
  readonly agentSettings?: AgentSettingsEnvelope;
  readonly [key: string]: unknown;
}

export class AgentRuntimeRouter {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #events: AgentEventBus;
  readonly #getCarryOverRevision: (chatId: string) => string;
  readonly #loadCarryOver: (chatId: string, entry: AgentChatEntry) => readonly ChatMessage[];

  constructor(options: AgentRuntimeRouterOptions) {
    this.#registry = options.registry;
    this.#directory = options.directory;
    this.#endpointResolver = options.endpointResolver;
    this.#events = options.events;
    this.#getCarryOverRevision = options.getCarryOverRevision;
    this.#loadCarryOver = options.loadCarryOver;
  }

  async startSession(chatId: string, prompt: string, opts: {
    images?: RunAgentTurnOptions['images'];
    model?: string;
    permissionMode?: RunAgentTurnOptions['permissionMode'];
    thinkingMode?: RunAgentTurnOptions['thinkingMode'];
    agentSettings?: AgentSettingsEnvelope;
    projectPath?: string;
    clientRequestId?: string;
    clientMessageId?: string;
    turnId?: string;
    commandType?: AgentExecutionCommandType;
    executionAdmission?: AgentExecutionAdmission;
    carryOver?: readonly ChatMessage[];
  } = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    if (getMaxSessions() > 0 && this.getRunningSessionCount() >= getMaxSessions()) {
      throw new Error(
        `Session limit reached (${getMaxSessions()}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`,
      );
    }
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const integration = this.#directory.require(entry.agentId);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: opts.model ?? entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    await this.#validateEndpoint(integration, selection);
    const resolvedPrompt = await resolveFileMentionsInCommand(prompt, entry.projectPath);
    assertExecutionAdmissionOpen(opts);
    const operation = operationIdentity(opts, opts.commandType ?? 'chat-start');
    const request = {
      ...this.#executionContext(chatId, entry, selection, operation, opts),
      prompt: resolvedPrompt,
      attachments: attachments(opts.images),
      carryOver: opts.carryOver ?? [],
    } satisfies Parameters<typeof integration.execution.start>[0];

    this.#events.trackTurn(chatId, operationMetadata(operation));
    let started: Awaited<ReturnType<typeof integration.execution.start>> | null = null;
    try {
      started = await integration.execution.start(request);
      assertExecutionAdmissionOpen(opts);
      const updated = await this.#registry.updateChat(chatId, {
        agentSessionId: started.agentSessionId,
        nativeSession: started.nativeSession,
        apiProviderId: selection.apiProviderId,
        modelEndpointId: selection.endpointId,
        modelProtocol: selection.protocol,
      }, { flush: true });
      if (!updated) throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    } catch (error) {
      this.#events.clearTurn(chatId);
      if (started) {
        await integration.execution.abort(started.agentSessionId).catch((abortError) => {
          logger.warn(
            `agents: failed to abort ${entry.agentId} session after registry bind failure:`,
            abortError instanceof Error ? abortError.message : String(abortError),
          );
        });
      }
      throw error;
    }
  }

  async runAgentTurn(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions = {},
  ): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    if (!entry.agentSessionId) {
      await this.startSession(chatId, prompt, {
        ...opts,
        commandType: opts.commandType ?? 'agent-run',
        carryOver: this.#loadCarryOver(chatId, entry),
      });
      return;
    }

    const previous = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: opts.model ?? entry.model,
      apiProviderId: opts.apiProviderId !== undefined ? opts.apiProviderId : entry.apiProviderId,
      modelEndpointId:
        opts.modelEndpointId !== undefined ? opts.modelEndpointId : entry.modelEndpointId,
    });
    assertSameApiProviderBoundary(previous, selection);
    const integration = this.#directory.require(entry.agentId);
    await this.#validateEndpoint(integration, selection);
    const resolvedPrompt = await resolveFileMentionsInCommand(prompt, entry.projectPath);
    assertExecutionAdmissionOpen(opts);
    const operation = operationIdentity(opts, opts.commandType ?? 'agent-run');
    this.#events.trackTurn(chatId, operationMetadata(operation));
    try {
      await integration.execution.resume({
        ...this.#executionContext(chatId, entry, selection, operation, opts),
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt: resolvedPrompt,
        attachments: attachments(opts.images),
      });
    } catch (error) {
      this.#events.clearTurn(chatId);
      throw error;
    }
  }

  async submitActiveInput(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean> {
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    if (!entry.agentSessionId) return false;
    const integration = this.#directory.require(entry.agentId);
    if (!integration.execution.submitActiveInput) return false;
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: opts.model ?? entry.model,
      apiProviderId: opts.apiProviderId !== undefined ? opts.apiProviderId : entry.apiProviderId,
      modelEndpointId:
        opts.modelEndpointId !== undefined ? opts.modelEndpointId : entry.modelEndpointId,
    });
    await this.#validateEndpoint(integration, selection);
    const operation = operationIdentity(opts, opts.commandType ?? 'agent-run');
    this.#events.trackTurn(chatId, operationMetadata(operation));
    return integration.execution.submitActiveInput({
      ...this.#executionContext(chatId, entry, selection, operation, opts),
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      prompt: await resolveFileMentionsInCommand(prompt, entry.projectPath),
      attachments: attachments(opts.images),
      beforeDelivery,
    });
  }

  async compactSession(chatId: string, opts: {
    instructions?: string;
    clientRequestId?: string;
    turnId?: string;
    executionAdmission?: AgentExecutionAdmission;
  } = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    if (!entry.agentSessionId) throw new Error(`Session missing agent session ID: ${chatId}`);
    const integration = this.#directory.require(entry.agentId);
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    await this.#validateEndpoint(integration, selection);
    const operation = operationIdentity(opts, 'agent-compact');
    const prompt = opts.instructions?.trim() ? `/compact ${opts.instructions.trim()}` : '/compact';
    this.#events.trackTurn(chatId, operationMetadata(operation));
    try {
      const request = {
        ...this.#executionContext(chatId, entry, selection, operation, opts),
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt,
        attachments: [],
      };
      if (integration.execution.compact) await integration.execution.compact(request);
      else await integration.execution.resume(request);
    } catch (error) {
      this.#events.clearTurn(chatId);
      throw error;
    }
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<void> {
    const integration = this.#directory.require(agentId);
    if (!integration.execution.prepareProjectPathUpdate) return;
    const entry = this.#registry.getChat(request.chatId);
    if (!entry) throw new Error(`Session not found: ${request.chatId}`);
    await integration.execution.prepareProjectPathUpdate({
      chat: toAgentChatReference(
        integration,
        request.chatId,
        entry,
        this.#getCarryOverRevision(request.chatId),
      ),
      nextProjectPath: request.nextProjectPath,
      signal: new AbortController().signal,
    });
  }

  async abortSession(chatId: string): Promise<boolean> {
    const entry = this.#registry.getChat(chatId);
    if (!entry?.agentSessionId) return false;
    return this.#directory.require(entry.agentId).execution.abort(entry.agentSessionId);
  }

  isChatRunning(chatId: string): boolean {
    const entry = this.#registry.getChat(chatId);
    return Boolean(entry && this.isAgentSessionRunning(entry.agentId, entry.agentSessionId));
  }

  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean {
    return Boolean(agentSessionId && this.#directory.get(agentId)?.execution.isRunning(agentSessionId));
  }

  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>> {
    const result: Record<string, Array<{ id: string; [key: string]: unknown }>> = {};
    for (const integration of this.#directory.list()) {
      result[integration.descriptor.id] = integration.execution.runningSessions().flatMap((session) => {
        const match = this.#registry.getChatByAgentSessionId(session.agentSessionId);
        return match ? [{
          id: match[0],
          ...(session.status ? { status: session.status } : {}),
          ...(session.startedAt ? { startedAt: session.startedAt } : {}),
        }] : [];
      });
    }
    return result;
  }

  getRunningChatIdsSnapshot(): string[] {
    const chatIds = new Set<string>();
    const unmapped: string[] = [];
    for (const integration of this.#directory.list()) {
      const sessions = integration.execution.runningSessions();
      if (!Array.isArray(sessions)) {
        throw new Error(`Running sessions for ${integration.descriptor.id} are not an array`);
      }
      for (const session of sessions) {
        const id = session?.agentSessionId?.trim();
        if (!id) throw new Error(`Running session for ${integration.descriptor.id} has no ID`);
        const match = this.#registry.getChatByAgentSessionId(id);
        if (match) chatIds.add(match[0]);
        else unmapped.push(id);
      }
    }
    if (unmapped.length > 0) {
      throw new Error(`Running chat snapshot has ${unmapped.length} unmapped session(s)`);
    }
    return [...chatIds].sort();
  }

  getRunningSessionCount(): number {
    return this.#directory
      .list()
      .reduce((total, integration) => total + integration.execution.runningSessions().length, 0);
  }

  resolvePermission(
    chatId: string,
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): void {
    const entry = this.#registry.getChat(chatId);
    const execution = entry ? this.#directory.get(entry.agentId)?.execution : null;
    if (!execution?.respondToPermission || !permissionRequestId) return;
    Promise.resolve(execution.respondToPermission(permissionRequestId, decision)).catch((error) => {
      logger.warn(
        'agents: permission reply failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  async forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }): Promise<StartedAgentSession | null> {
    if (
      args.messageSequence !== undefined
      && (!Number.isSafeInteger(args.messageSequence) || args.messageSequence <= 0)
    ) {
      throw new DomainError('VALIDATION_FAILED', 'messageSequence must be a positive safe integer', 400);
    }
    try {
      const source = requireAgentChatEntry(args.sourceChatId, args.sourceSession);
      const integration = this.#directory.require(source.agentId);
      if (!integration.forking) return null;
      const selection = this.#endpointResolver.resolveSelection({
        agentId: source.agentId,
        model: source.model,
        apiProviderId: source.apiProviderId,
        modelEndpointId: source.modelEndpointId,
      });
      await this.#validateEndpoint(integration, selection);
      const operation = operationIdentity({}, 'fork-run');
      const sourceReference = toAgentChatReference(
        integration,
        args.sourceChatId,
        source,
        this.#getCarryOverRevision(args.sourceChatId),
      );
      const sourceSnapshot = args.messageSequence
        ? await integration.transcript.load({
            chat: sourceReference,
            signal: new AbortController().signal,
          })
        : null;
      const carryOverMessageCount = args.messageSequence
        ? this.#loadCarryOver(args.sourceChatId, source).length
        : 0;
      if (args.messageSequence) {
        const messageCount = carryOverMessageCount + (sourceSnapshot?.messages.length ?? 0);
        if (args.messageSequence > messageCount) {
          throw new DomainError(
            'TRANSCRIPT_UNAVAILABLE',
            `Message not found for seq ${args.messageSequence}`,
            422,
          );
        }
      }
      const nativePrefixRevision = args.messageSequence
        ? computeAgentTranscriptRevisions(
            sourceSnapshot!.messages,
            Math.max(0, args.messageSequence - carryOverMessageCount),
          ).prefix
        : null;
      const result = await integration.forking.fork({
        ...this.#executionContext(args.targetChatId, source, selection, operation, {}),
        source: sourceReference,
        point: args.messageSequence ? {
          messageSequence: args.messageSequence,
          sourceRevision: {
            nativePrefix: nativePrefixRevision!,
            carryOver: sourceReference.carryOverRevision,
          },
        } : null,
      });
      return {
        agentSessionId: result.agentSessionId,
        nativeSession: result.nativeSession,
      };
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'OPERATION_UNSUPPORTED') {
        throw new DomainError('OPERATION_UNSUPPORTED', error.message, 422, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'SOURCE_REVISION_CHANGED') {
        throw new DomainError('SOURCE_REVISION_CHANGED', error.message, 409, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'TRANSCRIPT_UNAVAILABLE') {
        throw new DomainError('TRANSCRIPT_UNAVAILABLE', error.message, 422, error.retryable);
      }
      throw error;
    }
  }

  async discardForkedAgentSession(agentId: string, session: StartedAgentSession): Promise<void> {
    const forking = this.#directory.require(agentId).forking;
    if (!forking) return;
    await forking.discard(session, new AbortController().signal);
  }

  async runSingleQuery(
    prompt: string,
    options: RunSingleQueryOptions,
  ): Promise<string> {
    const { agentId } = options;
    const integration = this.#directory.require(agentId);
    if (!integration.singleQuery) throw new Error(`Single query unsupported for agent: ${agentId}`);
    const model = typeof options.model === 'string' ? options.model : '';
    const selection = model ? this.#endpointResolver.resolveSelection({
      agentId,
      model,
      apiProviderId: typeof options.apiProviderId === 'string' ? options.apiProviderId : null,
      modelEndpointId: typeof options.modelEndpointId === 'string' ? options.modelEndpointId : null,
    }) : null;
    if (selection) await this.#validateEndpoint(integration, selection);
    const timeoutMs = typeof options.timeoutMs === 'number'
      && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
    return integration.singleQuery.run({
      prompt,
      projectPath: typeof options.projectPath === 'string'
        ? options.projectPath
        : typeof options.cwd === 'string'
          ? options.cwd
          : process.cwd(),
      model: selection?.model ?? model,
      thinkingMode: normalizeThinkingMode(options.thinkingMode),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      settings: integration.settings.parse(
        isAgentSettingsEnvelope(options.agentSettings)
          ? options.agentSettings
          : integration.settings.defaults(),
      ),
      endpoint: selection ? toAgentEndpointSelection(this.#endpointResolver, selection) : null,
      signal: options.signal instanceof AbortSignal ? options.signal : new AbortController().signal,
    });
  }

  async discoverSlashCommands(agentId: string, projectPath: string) {
    const commands = this.#directory.get(agentId)?.commands;
    return commands
      ? [...(await commands.discover(projectPath, new AbortController().signal))]
      : [];
  }

  async #validateEndpoint(
    integration: ReturnType<AgentDirectory['require']>,
    selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>,
  ): Promise<void> {
    const endpoint = toAgentEndpointSelection(this.#endpointResolver, selection);
    if (!endpoint) return;
    if (!integration.endpoints) {
      throw new Error(
        `Agent integration ${integration.descriptor.id} does not accept API provider endpoints`,
      );
    }
    await integration.endpoints.validate(endpoint);
  }

  #executionContext(
    chatId: string,
    entry: ReturnType<typeof requireAgentChatEntry>,
    selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>,
    operation: AgentOperationIdentity,
    opts: {
      permissionMode?: RunAgentTurnOptions['permissionMode'];
      thinkingMode?: RunAgentTurnOptions['thinkingMode'];
      agentSettings?: RunAgentTurnOptions['agentSettings'];
      executionAdmission?: AgentExecutionAdmission;
    },
  ): AgentExecutionContext {
    const integration = this.#directory.require(entry.agentId);
    const permissionMode = supportedValue(
      integration.descriptor.supportedPermissionModes,
      normalizePermissionMode(opts.permissionMode ?? entry.permissionMode),
      'default',
    );
    const thinkingMode = supportedValue(
      integration.descriptor.supportedThinkingModes,
      normalizeThinkingMode(opts.thinkingMode ?? entry.thinkingMode),
      'none',
    );
    const settings = integration.settings.parse(
      opts.agentSettings ??
        entry.agentSettingsById?.[entry.agentId] ??
        integration.settings.defaults(),
    );
    return {
      chatId,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode,
      thinkingMode,
      settings,
      endpoint: toAgentEndpointSelection(this.#endpointResolver, selection),
      operation,
      admission: {
        signal: opts.executionAdmission?.signal ?? new AbortController().signal,
        markStarted: () => opts.executionAdmission?.markStarted(),
        markAbortable: () => this.#events.markTurnAbortable(chatId, operationMetadata(operation)),
      },
    };
  }
}

function operationIdentity(
  value: { clientRequestId?: string; clientMessageId?: string; turnId?: string },
  commandType: AgentExecutionCommandType,
): AgentOperationIdentity {
  return {
    commandType,
    clientRequestId: value.clientRequestId ?? null,
    clientMessageId: value.clientMessageId ?? null,
    turnId: value.turnId ?? crypto.randomUUID(),
  };
}

function operationMetadata(operation: AgentOperationIdentity) {
  return {
    commandType: operation.commandType,
    ...(operation.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    turnId: operation.turnId,
  };
}

function attachments(images: RunAgentTurnOptions['images'] = []) {
  return images.map((image) => ({
    kind: 'image' as const,
    data: image.data,
    name: image.name ?? null,
    mimeType: image.mimeType ?? 'application/octet-stream',
  }));
}

function supportedValue<T extends string>(values: readonly string[], value: T, fallback: T): T {
  return values.includes(value) ? value : fallback;
}

function isAgentSettingsEnvelope(value: unknown): value is AgentSettingsEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

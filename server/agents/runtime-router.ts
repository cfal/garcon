import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  type AgentForkPoint,
  type AgentNativeForkResolution,
  type AgentGoalControlHandoff,
  type AgentExecutionContextV4,
  type AgentTurnOwnerOperationIdentityV4,
  type AgentProjectPathUpdatePreparation,
  type AgentSteerResult,
  type AgentSteerTarget,
} from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import {
  createNativeSeedReceipt,
  type CarriedContext,
  type NativeSeedReceipt,
} from '@garcon/common/transcript-seed';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type ThinkingMode,
} from '../../common/chat-modes.js';
import type { IChatRegistry } from '../chats/store.js';
import { emptyEraId, reconcileArchivedTail } from '../chats/carryover-segments.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { getMaxSessions } from '../config.js';
import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { createLogger } from '../lib/log.js';
import { DomainError, transcriptUnavailableMessage } from '../lib/domain-error.js';
import type { AgentDirectory } from './directory.js';
import type { AgentEventBus } from './event-bus.js';
import type {
  AgentChatEntry,
  AgentExecutionAdmission,
  AgentExecutionCommandType,
  AgentSteerOptions,
  ForkedAgentSessionOutcome,
  PrepareProjectPathUpdateRequest,
  RunAgentTurnOptions,
  StartedAgentSession,
} from './session-types.js';
import { assertExecutionAdmissionOpen } from './session-types.js';
import { requireAgentChatEntry, toAgentEndpointSelection } from './execution-planning.js';
import { toAgentChatReference } from './integration-chat-reference.js';
import type { AgentProjectionIngress } from './projection-ingress.js';

const logger = createLogger('agents:runtime-router');

export interface AgentRuntimeRouterOptions {
  registry: IChatRegistry;
  directory: AgentDirectory;
  endpointResolver: ApiProviderEndpointResolver;
  events: AgentEventBus;
  projection: AgentProjectionIngress;
  getCarryOverRevision(entry: AgentChatEntry): string;
  loadCarriedContext(
    chatId: string,
    entry: AgentChatEntry,
    signal?: AbortSignal,
  ): Promise<CarriedContext | null>;
  getCarryOverMessageCount(entry: AgentChatEntry, signal?: AbortSignal): Promise<number>;
  onCarryOverChanged?: (chatId: string) => void | Promise<void>;
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
  readonly #projection: AgentProjectionIngress;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #loadCarriedContext: (
    chatId: string,
    entry: AgentChatEntry,
    signal?: AbortSignal,
  ) => Promise<CarriedContext | null>;
  readonly #getCarryOverMessageCount: (
    entry: AgentChatEntry,
    signal?: AbortSignal,
  ) => Promise<number>;
  readonly #onCarryOverChanged: (chatId: string) => void | Promise<void>;

  constructor(options: AgentRuntimeRouterOptions) {
    this.#registry = options.registry;
    this.#directory = options.directory;
    this.#endpointResolver = options.endpointResolver;
    this.#events = options.events;
    this.#projection = options.projection;
    this.#getCarryOverRevision = options.getCarryOverRevision;
    this.#loadCarriedContext = options.loadCarriedContext;
    this.#getCarryOverMessageCount = options.getCarryOverMessageCount;
    this.#onCarryOverChanged = options.onCarryOverChanged ?? (() => undefined);
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
      carriedContext?: CarriedContext | null;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  } = {}): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    if (getMaxSessions() > 0 && this.getRunningSessionCount() >= getMaxSessions()) {
      throw new Error(
        `Session limit reached (${getMaxSessions()}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`,
      );
    }
    const persistedEntry = this.#registry.getChat(chatId);
    const entry = requireAgentChatEntryWithModel(chatId, persistedEntry, opts.model);
    const integration = this.#directory.require(entry.agentId);
    const previous = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: persistedEntry?.model || entry.model,
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
    await this.#validateEndpoint(integration, selection);
    const resolvedPrompt = await resolveFileMentionsInCommand(prompt, entry.projectPath);
    assertExecutionAdmissionOpen(opts);
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'chat-start');
    await this.#openProjection(integration, chatId, entry, opts.executionAdmission?.signal);
    const request = {
      ...this.#executionContext(chatId, entry, selection, operation, opts),
      prompt: resolvedPrompt,
      attachments: attachments(opts.images),
        carriedContext: opts.carriedContext ?? null,
    } satisfies Parameters<typeof integration.execution.start>[0];

    this.#events.trackTurn(chatId, operationMetadata(operation));
    let started: Awaited<ReturnType<typeof integration.execution.start>> | null = null;
    try {
        started = await integration.execution.start(request);
        assertExecutionAdmissionOpen(opts);
        const nativeSeedReceipt = validateStartedReceipt(
          started.nativeSeedReceipt,
          request.carriedContext,
          started.agentSessionId,
        );
        const carryOverSegments = reconcileArchivedTail(
          entry.carryOverSegments ?? [],
          { agentId: entry.agentId, model: selection.model },
          () => emptyEraId(chatId, started!.agentSessionId),
          new Date().toISOString(),
        );
        const carryOverChanged = carryOverSegments !== entry.carryOverSegments;
        const updated = await this.#registry.updateChat(chatId, {
        agentSessionId: started.agentSessionId,
        nativeSession: started.nativeSession,
        model: selection.model,
        apiProviderId: selection.apiProviderId,
        modelEndpointId: selection.endpointId,
          modelProtocol: selection.protocol,
          nativeSeedReceipt,
          carryOverSegments,
      }, { flush: true });
      if (!updated) throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
      if (carryOverChanged) await this.#notifyCarryOverChanged(chatId);
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

  async #notifyCarryOverChanged(chatId: string): Promise<void> {
    try {
      await this.#onCarryOverChanged(chatId);
    } catch (error) {
      logger.warn('Post-session carryover invalidation failed', {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async runAgentTurn(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions = {},
  ): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const persistedEntry = this.#registry.getChat(chatId);
    const entry = requireAgentChatEntryWithModel(chatId, persistedEntry, opts.model);
      if (!entry.agentSessionId) {
        const carriedContext = await this.#loadCarriedContext(
          chatId,
          entry,
          opts.executionAdmission?.signal,
        );
        await this.startSession(chatId, prompt, {
        ...opts,
        commandType: opts.commandType ?? 'agent-run',
          carriedContext,
      });
      return;
    }

    const previous = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: persistedEntry?.model || entry.model,
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
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'agent-run');
    await this.#openProjection(integration, chatId, entry, opts.executionAdmission?.signal);
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

  async steerInput(
    chatId: string,
    input: string,
    options: AgentSteerOptions,
    target: AgentSteerTarget | null,
    prepareDelivery: () => Promise<void>,
  ): Promise<AgentSteerResult> {
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    if (!entry.agentSessionId) {
      return {
        kind: 'rejected',
        reason: 'no-active-turn',
        message: 'No active agent session',
      };
    }
    const integration = this.#directory.require(entry.agentId);
    if (!integration.steering) {
      throw new DomainError(
        'OPERATION_UNSUPPORTED',
        'This agent does not support steering',
        422,
      );
    }
    if (!entry.agentOwnershipEpoch) throw new Error('Agent ownership epoch is required');
    const active = this.#events.getActiveTurn(chatId);
    if (!active?.turnOwner) {
      return {
        kind: 'rejected',
        reason: 'no-active-turn',
        message: 'No active turn receipt owner',
      };
    }
    return integration.steering.steer({
      chatId,
      projectPath: entry.projectPath,
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      target,
      input,
      clientMessageId: options.clientMessageId,
      operation: {
        agentOwnershipEpoch: agentOwnershipEpoch(entry.agentOwnershipEpoch),
        commandType: 'steer',
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        turnId: active.turnOwner.turnId,
        turnOwner: active.turnOwner,
      },
      prepareDelivery,
    });
  }

  captureSteerTarget(chatId: string): AgentSteerTarget | null {
    const entry = this.#registry.getChat(chatId);
    if (!entry?.agentSessionId) return null;
    const steering = this.#directory.get(entry.agentId)?.steering;
    if (!steering) return null;
    return steering.captureTarget({
      chatId,
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
    });
  }

  async submitGoalControl(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>,
  ): Promise<boolean> {
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    if (!entry.agentSessionId) return false;
    const integration = this.#directory.require(entry.agentId);
    if (!integration.goals) return false;
    const selection = this.#endpointResolver.resolveSelection({
      agentId: entry.agentId,
      model: opts.model ?? entry.model,
      apiProviderId: opts.apiProviderId !== undefined ? opts.apiProviderId : entry.apiProviderId,
      modelEndpointId:
        opts.modelEndpointId !== undefined ? opts.modelEndpointId : entry.modelEndpointId,
    });
    await this.#validateEndpoint(integration, selection);
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'agent-run');
    const previousTurn = this.#events.getActiveTurn(chatId);
    return integration.goals.submitControl({
      ...this.#executionContext(chatId, entry, selection, operation, opts),
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      prompt: await resolveFileMentionsInCommand(prompt, entry.projectPath),
      attachments: attachments(opts.images),
      beforeDelivery: (handoff) => beforeDelivery(this.#events.handoffTurn(
        chatId,
        previousTurn,
        operationMetadata(operation),
        handoff,
      )),
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
    // Without the facet there is nothing to call. Sending the literal text
    // `/compact` as a prompt used to look like success while leaving the context
    // untouched and a stray message in the transcript.
    const compaction = integration.compaction;
    if (!compaction) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `${entry.agentId} does not support native compaction. Use /handoff to continue in a new chat instead.`,
        400,
      );
    }
    const operation = operationIdentity(entry, opts, 'agent-compact');
    await this.#openProjection(integration, chatId, entry, opts.executionAdmission?.signal);
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
      await compaction.compact(request);
    } catch (error) {
      this.#events.clearTurn(chatId);
      throw error;
    }
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    const integration = this.#directory.require(agentId);
    if (!integration.execution.prepareProjectPathUpdate) return;
    const entry = this.#registry.getChat(request.chatId);
    if (!entry) throw new Error(`Session not found: ${request.chatId}`);
    if (
      entry.agentId !== agentId
      || entry.agentSessionId !== request.agentSessionId
      || entry.projectPath !== request.previousProjectPath
    ) {
      throw new Error(`Session changed while preparing project path: ${request.chatId}`);
    }
    return integration.execution.prepareProjectPathUpdate({
      chat: toAgentChatReference(
        integration,
        request.chatId,
        { ...entry, nativeSession: request.nativeSession },
          this.#getCarryOverRevision(entry),
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
    let unmappedCount = 0;
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
        else unmappedCount += 1;
      }
    }
    if (unmappedCount > 0) {
      logger.warn('Running chat snapshot omitted unmapped sessions', { count: unmappedCount });
    }
    return [...chatIds].sort();
  }

  getRunningSessionCount(): number {
    return this.#directory
      .list()
      .reduce((total, integration) => total + integration.execution.runningSessions().length, 0);
  }

  async resolvePermission(
    chatId: string,
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const execution = entry ? this.#directory.get(entry.agentId)?.execution : null;
    if (!execution?.respondToPermission || !permissionRequestId) {
      throw new Error('The active integration cannot resolve this permission request');
    }
    await execution.respondToPermission(permissionRequestId, decision);
  }

  async forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }): Promise<ForkedAgentSessionOutcome | null> {
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
      const operation = operationIdentity(source, {}, 'fork-run');
      const sourceReference = toAgentChatReference(
        integration,
        args.sourceChatId,
        source,
        this.#getCarryOverRevision(source),
      );
      const sourceSnapshot = args.messageSequence
        ? await this.#projection.open(
            integration,
            sourceReference,
            new AbortController().signal,
          )
        : null;
      const carryOverMessageCount = args.messageSequence
        ? await this.#getCarryOverMessageCount(source)
        : 0;
      if (args.messageSequence) {
        if (sourceSnapshot?.kind !== 'ready') {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'Source transcript is unavailable',
            sourceSnapshot?.kind === 'deferred'
              || (sourceSnapshot?.kind === 'degraded' && sourceSnapshot.retryable),
          );
        }
        const messageCount = carryOverMessageCount
          + sourceSnapshot.value.entries.length;
        if (args.messageSequence > messageCount) {
          throw new DomainError(
            'TRANSCRIPT_UNAVAILABLE',
            `Message not found for seq ${args.messageSequence}`,
            422,
          );
        }
      }
      let point: {
        readonly projection: AgentForkPoint;
        readonly native: import('@garcon/server-agent-interface').AgentNativeForkRef;
      } | null = null;
      if (args.messageSequence && sourceSnapshot?.kind === 'ready') {
        const currentOrdinal = args.messageSequence - carryOverMessageCount;
        const entry = sourceSnapshot.value.entries[currentOrdinal - 1];
        if (!entry || entry.lifetime !== 'durable') {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'The selected transcript entry is not durably settled',
            true,
          );
        }
        const projectionPoint: AgentForkPoint = {
          kind: 'projection-entry',
          agentOwnershipEpoch: sourceReference.agentOwnershipEpoch,
          contentEpoch: sourceSnapshot.value.checkpoint.projection.contentEpoch,
          entryId: entry.id,
          durableRevision: sourceSnapshot.value.checkpoint.projection.durableRevision,
        };
        const resolution = await integration.forking.resolvePoint({
          source: sourceReference,
          point: projectionPoint,
          signal: new AbortController().signal,
        });
        if (resolution.kind === 'degraded') {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            'The provider-native fork point is unavailable',
            resolution.retryable,
            { projectionErrorCode: resolution.errorCode },
          );
        }
        if (resolution.kind === 'unavailable') {
          throw new AgentIntegrationError(
            'TRANSCRIPT_UNAVAILABLE',
            nativeForkUnavailableMessage(resolution.reason),
            resolution.reason === 'projection-ahead-of-provider'
              || resolution.reason === 'not-settled',
          );
        }
        point = { projection: projectionPoint, native: resolution.reference };
      }
      const result = await integration.forking.fork({
        ...this.#executionContext(args.targetChatId, source, selection, operation, {}),
        source: sourceReference,
        point,
      });
      if (result.kind === 'unmaterialized') return result;
      return {
        kind: 'materialized',
        session: {
          agentSessionId: result.session.agentSessionId,
          nativeSession: result.session.nativeSession,
          nativeSeedReceipt: result.session.nativeSeedReceipt,
        },
      };
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'OPERATION_UNSUPPORTED') {
        throw new DomainError('OPERATION_UNSUPPORTED', error.message, 422, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'SOURCE_REVISION_CHANGED') {
        throw new DomainError('SOURCE_REVISION_CHANGED', error.message, 409, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'TRANSCRIPT_UNAVAILABLE') {
        throw new DomainError(
          'TRANSCRIPT_UNAVAILABLE',
          transcriptUnavailableMessage(error.retryable),
          422,
          error.retryable,
        );
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
    operation: AgentTurnOwnerOperationIdentityV4,
    opts: {
      permissionMode?: RunAgentTurnOptions['permissionMode'];
      thinkingMode?: RunAgentTurnOptions['thinkingMode'];
      agentSettings?: RunAgentTurnOptions['agentSettings'];
      executionAdmission?: AgentExecutionAdmission;
    },
  ): AgentExecutionContextV4 {
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
        markStarted: async () => {
          await opts.executionAdmission?.markStarted();
        },
        markAbortable: () => this.#events.markTurnAbortable(chatId, operationMetadata(operation)),
      },
    };
  }

  async #openProjection(
    integration: ReturnType<AgentDirectory['require']>,
    chatId: string,
    entry: ReturnType<typeof requireAgentChatEntry>,
    signal = new AbortController().signal,
  ): Promise<void> {
    const opened = await this.#projection.open(
      integration,
      toAgentChatReference(
        integration,
        chatId,
        entry,
        this.#getCarryOverRevision(entry),
      ),
      signal,
    );
    if (opened.kind === 'ready') return;
    throw new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      opened.kind === 'deferred'
        ? 'The transcript is busy. Retry after the current execution settles.'
        : 'The transcript projection is unavailable.',
      409,
      true,
    );
  }
}

function requireAgentChatEntryWithModel(
  chatId: string,
  entry: AgentChatEntry | null | undefined,
  model: string | undefined,
): ReturnType<typeof requireAgentChatEntry> {
  return requireAgentChatEntry(
    chatId,
    entry && model !== undefined ? { ...entry, model } : entry,
  );
}

function operationIdentity(
  entry: Pick<AgentChatEntry, 'agentOwnershipEpoch'>,
  value: { clientRequestId?: string; clientMessageId?: string; turnId?: string },
  commandType: AgentExecutionCommandType,
): AgentTurnOwnerOperationIdentityV4 {
  if (!entry.agentOwnershipEpoch) throw new Error('Agent ownership epoch is required');
  const clientRequestId = value.clientRequestId ?? crypto.randomUUID();
  const turnId = value.turnId ?? crypto.randomUUID();
  const ownershipEpoch = agentOwnershipEpoch(entry.agentOwnershipEpoch);
  const turnOwner = {
    agentOwnershipEpoch: ownershipEpoch,
    commandType,
    clientRequestId,
    turnId,
  } as const;
  return {
    agentOwnershipEpoch: ownershipEpoch,
    commandType,
    clientRequestId,
    clientMessageId: value.clientMessageId ?? null,
    turnId,
    turnOwner,
  };
}

function operationMetadata(operation: AgentTurnOwnerOperationIdentityV4) {
  return {
    commandType: operation.commandType,
    ...(operation.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    turnId: operation.turnId,
    agentOwnershipEpoch: operation.agentOwnershipEpoch,
    turnOwner: operation.turnOwner,
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

function nativeForkUnavailableMessage(
  reason: Extract<AgentNativeForkResolution, { readonly kind: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'below-native-retention-floor':
      return 'The selected message is visible but no longer retained by the provider for forking';
    case 'no-native-source':
      return 'The selected message has no provider-native fork position';
    case 'projection-ahead-of-provider':
      return 'The selected message has not reached provider-native storage yet';
    case 'not-settled':
      return 'The selected message is not settled for provider-native forking';
    case 'source-diverged':
      return 'The provider-native session diverged from the selected transcript entry';
  }
}

function validateStartedReceipt(
  receipt: NativeSeedReceipt | null,
  carriedContext: CarriedContext | null,
  agentSessionId: string,
): NativeSeedReceipt | null {
  if (!carriedContext) {
    if (receipt !== null) throw new Error('Agent returned a seed receipt without carried context');
    return null;
  }
  if (!receipt) throw new Error('Agent did not return a receipt for carried context');
  const expected = createNativeSeedReceipt({
    agentSessionId,
    placement: receipt.placement,
    prefix: carriedContext.prefix,
  });
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('Agent returned an invalid carried-context receipt');
  }
  return receipt;
}

function isAgentSettingsEnvelope(value: unknown): value is AgentSettingsEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

import crypto from 'node:crypto';
import {
  AgentIntegrationError,
  type AgentGoalControlHandoff,
  type AgentProjectPathUpdatePreparation,
  type AgentSteerResult,
  type AgentSteerTarget,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import {
  renderCarriedContext,
  type CarriedContext,
} from '@garcon/common/transcript-seed';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { ChatTransientControlAction } from '../../common/chat-transient-feed.js';
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
import type { TurnReceiptOwner } from '../lib/turn-identity.js';
import { DomainError, transcriptUnavailableMessage } from '../lib/domain-error.js';
import { ownershipTransferPendingError } from './ownership-transfer-fence.js';
import type { AgentDirectory } from './directory.js';
import type { AgentEventBus, TurnEventMetadata } from './event-bus.js';
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
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type {
  TranscriptLedgerService,
  TranscriptProducerLease,
} from '../ledger/service.js';
import {
  dispatchFailureDetail,
} from './runtime-router-errors.js';
const logger = createLogger('agents:runtime-router');

interface TurnOperation extends TurnReceiptOwner {
  readonly clientMessageId: string | null;
  readonly turnOwner: TurnReceiptOwner;
}

export interface AgentRuntimeRouterOptions {
  registry: IChatRegistry;
  directory: AgentDirectory;
  endpointResolver: ApiProviderEndpointResolver;
  events: AgentEventBus;
  getCarryOverRevision(entry: AgentChatEntry): string;
  createCarriedContext?(
    chatId: string,
    entry: AgentChatEntry,
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarriedContext | null>;
  ledger: TranscriptLedgerService;
  adoption: TranscriptAdoptionService;
  hasPendingOwnershipTransfer(chatId: string): boolean;
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
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #createCarriedContext: NonNullable<AgentRuntimeRouterOptions['createCarriedContext']>;
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #hasPendingOwnershipTransfer: (chatId: string) => boolean;
  readonly #producerLeases = new Map<string, TranscriptProducerLease>();
  readonly #executionHandles = new Map<string, {
    readonly agentId: string;
    readonly runId: string;
    readonly handle: AgentExecutionHandle;
  }>();
  readonly #pendingAbortRuns = new Set<string>();

  constructor(options: AgentRuntimeRouterOptions) {
    this.#registry = options.registry;
    this.#directory = options.directory;
    this.#endpointResolver = options.endpointResolver;
    this.#events = options.events;
    this.#getCarryOverRevision = options.getCarryOverRevision;
    this.#createCarriedContext = options.createCarriedContext
      ?? (async (_chatId, _entry, messages) => renderCarriedContext(messages));
    this.#ledger = options.ledger;
    this.#adoption = options.adoption;
    this.#hasPendingOwnershipTransfer = options.hasPendingOwnershipTransfer;
    this.#ledger.subscribe((event) => {
      if (event.type !== 'run-ended') return;
      if (this.#executionHandles.get(event.chatId)?.runId === event.runId) {
        this.#executionHandles.delete(event.chatId);
      }
    });
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
    await this.#adoption.ensure(chatId, opts.executionAdmission?.signal);
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
    const prepared = await this.#preparePrompt(chatId, prompt, opts);
    if (!prepared.dispatch) return;
    assertExecutionAdmissionOpen(opts);
    const carriedContext = await this.#createCarriedContext(
      chatId,
      entry,
      prepared.priorContext,
      opts.executionAdmission?.signal,
    );
    assertExecutionAdmissionOpen(opts);
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'chat-start');
    this.#events.trackTurn(chatId, operationMetadata(operation));
    const producer = this.#producer(chatId);
    const runId = this.#ledger.beginRun(chatId, operation.turnId);
    try {
    const handle = await integration.execution.start({
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        sink: producer.sink,
        priorContext: prepared.priorContext,
        prompt: prepared.prompt,
        attachments: prepared.attachments,
        carriedContext,
      });
      await this.#retainOrAbortHandle(chatId, entry.agentId, runId, handle);
      assertExecutionAdmissionOpen(opts);
      const updated = this.#registry.updateChat(chatId, {
        model: selection.model,
        apiProviderId: selection.apiProviderId,
        modelEndpointId: selection.endpointId,
        modelProtocol: selection.protocol,
      });
      if (!updated) throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    } catch (error) {
      this.#pendingAbortRuns.delete(runKey(chatId, runId));
      this.#ledger.failRun(chatId, runId, dispatchFailureDetail(error));
      throw error;
    }
  }

  async runAgentTurn(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions = {},
  ): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    await this.#adoption.ensure(chatId, opts.executionAdmission?.signal);
    const persistedEntry = this.#registry.getChat(chatId);
    const entry = requireAgentChatEntryWithModel(chatId, persistedEntry, opts.model);
    if (!entry.agentSessionId) {
      await this.startSession(chatId, prompt, {
        ...opts,
        commandType: opts.commandType ?? 'agent-run',
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
    const prepared = await this.#preparePrompt(chatId, prompt, opts);
    if (!prepared.dispatch) return;
    assertExecutionAdmissionOpen(opts);
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'agent-run');
    this.#events.trackTurn(chatId, operationMetadata(operation));
    const producer = this.#producer(chatId);
    const runId = this.#ledger.beginRun(chatId, operation.turnId);
    try {
      const handle = await integration.execution.resume({
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        sink: producer.sink,
        priorContext: prepared.priorContext,
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt: prepared.prompt,
        attachments: prepared.attachments,
      });
      await this.#retainOrAbortHandle(chatId, entry.agentId, runId, handle);
    } catch (error) {
      this.#pendingAbortRuns.delete(runKey(chatId, runId));
      this.#ledger.failRun(chatId, runId, dispatchFailureDetail(error));
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
    return integration.steering.steer({
      chatId,
      projectPath: entry.projectPath,
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      target,
      input,
      clientMessageId: options.clientMessageId,
      prepareDelivery: async () => {
        await prepareDelivery();
        this.#ledger.takePreparedInput(chatId, options.clientMessageId);
      },
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
    const previousRunId = this.#ledger.activeRunId(chatId);
    if (!previousRunId) return false;
    const producer = this.#producer(chatId);
    return integration.goals.submitControl({
      ...this.#executionContextV5(chatId, entry, selection, operation.turnId, opts),
      sink: producer.sink,
      priorContext: this.#ledger.conversationMessages(chatId),
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      prompt: await resolveFileMentionsInCommand(prompt, entry.projectPath),
      attachments: attachments(opts.images),
      beforeDelivery: async (handoff) => {
        await beforeDelivery(this.#goalRunHandoff({
          chatId,
          previousRunId,
          nextRunId: operation.turnId,
          previousTurn,
          nextTurn: operationMetadata(operation),
          downstream: handoff,
        }));
        this.#ledger.takePreparedInput(chatId, opts.clientMessageId);
      },
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
    const prompt = opts.instructions?.trim() ? `/compact ${opts.instructions.trim()}` : '/compact';
    this.#events.trackTurn(chatId, operationMetadata(operation));
    const producer = this.#producer(chatId);
    const runId = this.#ledger.beginRun(chatId, operation.turnId);
    try {
      const request = {
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        sink: producer.sink,
        priorContext: this.#ledger.conversationMessages(chatId),
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt,
        attachments: [],
      };
      const handle = await compaction.compact(request);
      await this.#retainOrAbortHandle(chatId, entry.agentId, runId, handle);
    } catch (error) {
      this.#pendingAbortRuns.delete(runKey(chatId, runId));
      this.#ledger.failRun(chatId, runId, dispatchFailureDetail(error));
      throw error;
    }
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    const integration = this.#directory.require(agentId);
    if (!integration.projectPathUpdates) return;
    const entry = this.#registry.getChat(request.chatId);
    if (!entry) throw new Error(`Session not found: ${request.chatId}`);
    if (
      entry.agentId !== agentId
      || entry.agentSessionId !== request.agentSessionId
      || entry.projectPath !== request.previousProjectPath
    ) {
      throw new Error(`Session changed while preparing project path: ${request.chatId}`);
    }
    return integration.projectPathUpdates.prepare({
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

  abortSession(chatId: string): Promise<boolean> {
    const runId = this.#ledger.activeRunId(chatId);
    if (!runId) return Promise.resolve(false);
    const active = this.#executionHandles.get(chatId);
    this.#ledger.interruptRun(chatId);
    if (!active || active.runId !== runId) {
      this.#pendingAbortRuns.add(runKey(chatId, runId));
      return Promise.resolve(true);
    }
    this.#executionHandles.delete(chatId);
    this.#abortHandleBestEffort(chatId, active.agentId, active.handle, 'accepted interruption');
    return Promise.resolve(true);
  }

  isChatRunning(chatId: string): boolean {
    return this.#ledger.isRunActive(chatId);
  }

  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean {
    if (!agentSessionId) return false;
    const match = this.#registry.getChatByAgentSessionId(agentSessionId);
    return Boolean(match && match[1].agentId === agentId && this.#ledger.isRunActive(match[0]));
  }

  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>> {
    const result: Record<string, Array<{ id: string; [key: string]: unknown }>> = {};
    const activeChatIds = this.#ledger.activeChatIds();
    for (const integration of this.#directory.list()) {
      result[integration.descriptor.id] = activeChatIds
        .filter((chatId) => this.#registry.getChat(chatId)?.agentId === integration.descriptor.id)
        .map((chatId) => ({ id: chatId, status: 'running' }));
    }
    return result;
  }

  getRunningChatIdsSnapshot(): string[] {
    return [...this.#ledger.activeChatIds()].sort();
  }

  getRunningSessionCount(): number {
    return this.#ledger.activeChatIds().length;
  }

  async resolvePermission(
    chatId: string,
    permissionOccurrenceId: string,
    decision: PermissionDecisionPayload,
    control: ChatTransientControlAction,
  ): Promise<void> {
    if (!permissionOccurrenceId) throw new Error('Permission occurrence ID is required');
    if (
      control.chatId !== chatId
      || control.permissionOccurrenceId !== permissionOccurrenceId
    ) {
      throw new Error('Permission control does not match the request');
    }
    const claim = this.#ledger.claimPermissionResolution(control);
    try {
      await claim.decision.respond(decision);
    } catch (error) {
      this.#ledger.abandonPermissionResolution(claim);
      throw error;
    }
    this.#ledger.completePermissionResolution(claim, decision);
  }

  async forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageOrdinal?: number;
    providerMeta?: JsonObject | null;
  }): Promise<ForkedAgentSessionOutcome | null> {
    if (
      args.messageOrdinal !== undefined
      && (!Number.isSafeInteger(args.messageOrdinal) || args.messageOrdinal <= 0)
    ) {
      throw new DomainError('VALIDATION_FAILED', 'messageOrdinal must be a positive safe integer', 400);
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
      const context = this.#executionContextV5(
        args.targetChatId,
        source,
        selection,
        operation.turnId,
        {},
      );
      const result = await integration.forking.fork({
        chatId: context.chatId,
        projectPath: context.projectPath,
        model: context.model,
        permissionMode: context.permissionMode,
        thinkingMode: context.thinkingMode,
        settings: context.settings,
        endpoint: context.endpoint,
        admission: context.admission,
        source: sourceReference,
        providerMeta: args.messageOrdinal === undefined ? null : args.providerMeta ?? null,
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
        return null;
      }
      if (error instanceof AgentIntegrationError && error.code === 'SOURCE_REVISION_CHANGED') {
        throw new DomainError('SOURCE_REVISION_CHANGED', error.message, 409, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'TRANSCRIPT_UNAVAILABLE') {
        // A refusal means the row exists in the ledger but the provider has not written it
        // to native history yet. Reporting it lets the caller retry once it settles;
        // returning null here would silently hand back a fork with no native session.
        if (error.details?.nativeForkReason === 'not-settled') {
          throw new DomainError(
            'TRANSCRIPT_NOT_YET_PERSISTED',
            'The selected message is not in the agent\'s native history yet. Try again shortly.',
            409,
            true,
          );
        }
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

  async #preparePrompt(
    chatId: string,
    fallbackPrompt: string,
    opts: Pick<RunAgentTurnOptions, 'clientMessageId' | 'images'>,
  ): Promise<{
    readonly dispatch: boolean;
    readonly prompt: string;
    readonly attachments: ReturnType<typeof attachments>;
    readonly priorContext: readonly ChatMessage[];
  }> {
    const composition = this.#ledger.takePreparedInput(chatId, opts.clientMessageId);
    if (composition && !composition.inserted) {
      return { dispatch: false, prompt: '', attachments: [], priorContext: [] };
    }
    const promptRows = composition?.prompt ?? [];
    const prompt = promptRows.length > 0
      ? promptRows.map((row) => row.detail.message.content).join('\n\n')
      : fallbackPrompt;
    const excluded = new Set(promptRows.map((row) => row.ordinal));
    const preparedAttachments = promptRows.length > 0
      ? promptRows.flatMap((row) => row.detail.attachments)
      : attachments(opts.images);
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    return {
      dispatch: true,
      prompt: await resolveFileMentionsInCommand(prompt, entry.projectPath),
      attachments: [...preparedAttachments],
      priorContext: this.#ledger.conversationMessages(chatId, excluded),
    };
  }

  #goalRunHandoff(input: {
    readonly chatId: string;
    readonly previousRunId: string;
    readonly nextRunId: string;
    readonly previousTurn: TurnEventMetadata | undefined;
    readonly nextTurn: TurnEventMetadata;
    readonly downstream: AgentGoalControlHandoff;
  }): AgentGoalControlHandoff {
    const eventHandoff = this.#events.handoffTurn(
      input.chatId,
      input.previousTurn,
      input.nextTurn,
      input.downstream,
    );
    const validate = () => {
      if (!this.#ledger.isRunActive(input.chatId, input.previousRunId)) {
        throw new Error(`Cannot hand off run for chat ${input.chatId} after its active run changed`);
      }
      eventHandoff.validate();
    };
    validate();
    return {
      validate,
      commit: () => {
        validate();
        eventHandoff.commit();
        this.#ledger.handoffRun(input.chatId, input.previousRunId, input.nextRunId);
        const active = this.#executionHandles.get(input.chatId);
        if (active?.runId === input.previousRunId) {
          this.#executionHandles.set(input.chatId, {
            ...active,
            runId: input.nextRunId,
          });
        }
      },
    };
  }

  async #retainOrAbortHandle(
    chatId: string,
    agentId: string,
    runId: string,
    handle: AgentExecutionHandle,
  ): Promise<void> {
    if (this.#pendingAbortRuns.delete(runKey(chatId, runId))) {
      this.#abortHandleBestEffort(chatId, agentId, handle, 'interrupted launch');
      return;
    }
    if (this.#ledger.isRunActive(chatId, runId)) {
      this.#executionHandles.set(chatId, { agentId, runId, handle });
    }
  }

  #abortHandleBestEffort(
    chatId: string,
    agentId: string,
    handle: AgentExecutionHandle,
    context: string,
  ): void {
    const failed = (error: unknown) => {
      logger.warn(`Provider abort after ${context} failed`, {
        chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      void this.#directory.require(agentId).execution.abort(handle).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  #producer(chatId: string): TranscriptProducerLease {
    const existing = this.#producerLeases.get(chatId);
    if (existing && !existing.closed) return existing;
    if (this.#hasPendingOwnershipTransfer(chatId)) throw ownershipTransferPendingError();
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const lease = this.#ledger.openProducer(chatId, entry.agentId);
    this.#producerLeases.set(chatId, lease);
    return lease;
  }

  reopenProducer(chatId: string): void {
    this.#producerLeases.get(chatId)?.close();
    this.#producerLeases.delete(chatId);
    this.#producer(chatId);
  }

  publishSessionFact(chatId: string, session: AgentEstablishedSession): void {
    this.#producer(chatId).sink.publish({ type: 'session', session });
  }

  #executionContextV5(
    chatId: string,
    entry: ReturnType<typeof requireAgentChatEntry>,
    selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>,
    runId: string,
    opts: {
      permissionMode?: RunAgentTurnOptions['permissionMode'];
      thinkingMode?: RunAgentTurnOptions['thinkingMode'];
      agentSettings?: RunAgentTurnOptions['agentSettings'];
      executionAdmission?: AgentExecutionAdmission;
    },
  ) {
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
      opts.agentSettings
        ?? entry.agentSettingsById?.[entry.agentId]
        ?? integration.settings.defaults(),
    );
    return {
      chatId,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode,
      thinkingMode,
      settings,
      endpoint: toAgentEndpointSelection(this.#endpointResolver, selection),
      runId,
      admission: {
        signal: opts.executionAdmission?.signal ?? new AbortController().signal,
        markStarted: async () => {
          await opts.executionAdmission?.markStarted();
        },
      },
    };
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
): TurnOperation {
  if (!entry.agentOwnershipEpoch) throw new Error('Agent ownership epoch is required');
  const clientRequestId = value.clientRequestId ?? crypto.randomUUID();
  const turnId = value.turnId ?? crypto.randomUUID();
  const turnOwner = {
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
    commandType,
    clientRequestId,
    turnId,
  } as const;
  return {
    agentOwnershipEpoch: entry.agentOwnershipEpoch,
    commandType,
    clientRequestId,
    clientMessageId: value.clientMessageId ?? null,
    turnId,
    turnOwner,
  };
}

function operationMetadata(operation: TurnOperation) {
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

function runKey(chatId: string, runId: string): string {
  return `${chatId}\u0000${runId}`;
}

function isAgentSettingsEnvelope(value: unknown): value is AgentSettingsEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

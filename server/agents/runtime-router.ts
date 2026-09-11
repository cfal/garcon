import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderSteerTarget, ProviderExecutionOperation, ProviderExecutionService } from '../execution-nodes/provider-execution.js';
import {
  AgentIntegrationError,
  type AgentGoalControlHandoff,
  type AgentProjectPathUpdatePreparation,
  type AgentSteerResult,
  type AgentSteerTarget,
  type AgentEstablishedSession,
  type AgentEmissionSink,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ExecutionInstanceRef, LocatedChatOwner } from '@garcon/common/execution-location';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { ChatTransientControlAction } from '../../common/chat-transient-feed.js';
import type { ThinkingMode } from '../../common/chat-modes.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { getMaxSessions } from '../config.js';
import { resolveFileMentionsInCommand } from '../chats/file-mentions.js';
import { createLogger } from '../lib/log.js';
import type { TurnReceiptOwner } from '../lib/turn-identity.js';
import { DomainError, transcriptUnavailableMessage } from '../lib/domain-error.js';
import { ownershipTransferPendingError } from './ownership-transfer-fence.js';
import { localEmissionSink } from './local-emission.js';
import type { AgentDirectory } from './directory.js';
import type { AgentInstanceDirectory } from './instance-directory.js';
import type { AgentEventBus, TurnEventMetadata } from './event-bus.js';
import type {
  AgentChatEntry,
  AgentExecutionAdmission,
  AgentExecutionCommandType,
  PreparedExecutionTurn,
  AgentSteerOptions,
  ForkedAgentSessionOutcome,
  PrepareProjectPathUpdateRequest,
  RunAgentTurnOptions,
  StartedAgentSession,
} from './session-types.js';
import { assertExecutionAdmissionOpen } from './session-types.js';
import { requireAgentChatEntry, toAdmittedEndpoint } from './execution-planning.js';
import { toAgentChatReference, toProviderNativeChatReference } from './integration-chat-reference.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import { resolveCarryOverOutcome, type CarryOverOutcome } from '../chats/carryover-outcome.js';
import type {
  TranscriptLedgerService,
  TranscriptProducerLease,
} from '../ledger/service.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import {
  dispatchFailureDetail,
} from './runtime-router-errors.js';
const logger = createLogger('agents:runtime-router');

interface TurnOperation extends TurnReceiptOwner {
  readonly clientMessageId: string | null;
  readonly turnOwner: TurnReceiptOwner;
}

interface LocalProducerBinding {
  readonly lease: TranscriptProducerLease;
  readonly output: AgentEmissionSink;
}

interface RuntimeExecutionOccurrence {
  readonly service: ProviderExecutionService;
  readonly operation: ProviderExecutionOperation;
  runId: string;
}

interface PreparedTurn {
  readonly chatId: string;
  readonly kind: 'start' | 'resume' | 'compact';
  readonly entry: ReturnType<typeof requireAgentChatEntry>;
  readonly selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>;
  readonly turn: TurnOperation;
  readonly service: ProviderExecutionService;
  readonly operation: ProviderExecutionOperation;
  readonly configurationInput: ReturnType<typeof executionConfiguration>;
  readonly validateBinding: () => void;
  readonly releaseCapacity: () => void;
  readonly release: () => void;
}

export interface AgentRuntimeRouterOptions {
  registry: IChatRegistry;
  directory: AgentDirectory;
  localNodeId: string;
  instances: Pick<AgentInstanceDirectory,
    'get' | 'requireFor' | 'defaultFor' | 'executionFor' | 'configurationFor' | 'commandsForInstance' | 'nativeForkFor' | 'singleQueryForInstance'>;
  endpointResolver: ApiProviderEndpointResolver;
  events: AgentEventBus;
  getCarryOverRevision(entry: AgentChatEntry): string;
  createCarriedContext(input: CreateCarriedContextInput): Promise<CarryOverOutcome>;
  ledger: TranscriptLedgerService;
  adoption: TranscriptAdoptionService;
  hasPendingOwnershipTransfer(chatId: string): boolean;
}

export interface CreateCarriedContextInput {
  readonly chatId: string;
  readonly entry: AgentChatEntry;
  readonly messages: readonly ChatMessage[];
  readonly transcriptViewId: TranscriptViewId;
  readonly destinationPrompt: string;
  readonly clientRequestId: string | null;
  readonly signal?: AbortSignal;
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

type PreparedPrompt =
  | { readonly dispatch: false }
  | {
      readonly dispatch: true;
      readonly prompt: string;
      readonly outboundPrompt: string;
      readonly attachments: ReturnType<typeof attachments>;
      readonly excludedOrdinals: ReadonlySet<number>;
      readonly viewId: TranscriptViewId;
    };

export class AgentRuntimeRouter {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #instances: AgentRuntimeRouterOptions['instances'];
  readonly #localNodeId: string;
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #events: AgentEventBus;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #createCarriedContext: AgentRuntimeRouterOptions['createCarriedContext'];
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #hasPendingOwnershipTransfer: (chatId: string) => boolean;
  readonly #producerLeases = new Map<string, LocalProducerBinding>();
  readonly #executions = new Map<string, RuntimeExecutionOccurrence>();
  readonly #preparedTurns = new WeakMap<PreparedExecutionTurn, PreparedTurn>();
  #preparedStarts = 0;
  readonly #steerTargets = new WeakMap<AgentSteerTarget, {
    readonly chatId: string; readonly occurrence: RuntimeExecutionOccurrence; readonly runId: string;
    prepared: ProviderSteerTarget | null;
  }>();

  constructor(options: AgentRuntimeRouterOptions) {
    this.#registry = options.registry;
    this.#directory = options.directory;
    this.#instances = options.instances;
    this.#localNodeId = options.localNodeId;
    this.#endpointResolver = options.endpointResolver;
    this.#events = options.events;
    this.#getCarryOverRevision = options.getCarryOverRevision;
    this.#createCarriedContext = options.createCarriedContext;
    this.#ledger = options.ledger;
    this.#adoption = options.adoption;
    this.#hasPendingOwnershipTransfer = options.hasPendingOwnershipTransfer;
    this.#ledger.subscribe((event) => {
      if (event.type !== 'run-ended') return;
      if (this.#executions.get(event.chatId)?.runId === event.runId) {
        this.#executions.delete(event.chatId);
      }
    });
  }
  async prepareTurn(chatId: string, options: RunAgentTurnOptions, signal: AbortSignal): Promise<PreparedExecutionTurn> {
    signal.throwIfAborted();
    const view = await this.#adoption.ensure(chatId, signal);
    signal.throwIfAborted();
    const persisted = this.#registry.getChat(chatId);
    const entry = structuredClone(requireAgentChatEntryWithModel(chatId, persisted, options.model));
    const kind = options.commandType === 'agent-compact' ? 'compact' : entry.agentSessionId ? 'resume' : 'start';
    if (kind === 'compact' && !entry.agentSessionId) throw new Error(`Session missing agent session ID: ${chatId}`);
    const selection = this.#resolveExecutionSelection(persisted, entry, options);
    const binding = executionBinding(persisted!);
    const configurationInput = executionConfiguration(persisted!);
    const service = this.#instances.executionFor(entry);
    const turn = operationIdentity(entry, options, options.commandType ?? 'agent-run');
    const validateBinding = () => {
      const current = this.#registry.getChat(chatId);
      if (this.#hasPendingOwnershipTransfer(chatId)) throw ownershipTransferPendingError();
      if (!current || !isDeepStrictEqual(executionBinding(current), binding)
        || this.#ledger.currentView(chatId)?.viewId !== view.viewId
        || this.#instances.executionFor(current) !== service) {
        throw new DomainError('SESSION_BUSY', 'The chat execution binding changed during preparation. Submit again.', 409, true);
      }
    };
    const validate = () => {
      validateBinding();
      if (!isDeepStrictEqual(executionConfiguration(this.#registry.getChat(chatId)!), configurationInput)) {
        throw new DomainError('SESSION_BUSY', 'The chat settings changed during preparation. Submit again.', 409, true);
      }
    };
    const request = {
      chatId, projectPath: entry.projectPath, runId: turn.turnId,
      configuration: this.#configurationRequest(entry, selection, options),
    };
    const releaseCapacity = kind === 'start' ? this.#reserveStartCapacity() : () => {};
    let operation: ProviderExecutionOperation;
    try {
      operation = await service.prepare(kind === 'start' ? { ...request, kind } : {
        ...request, kind, agentSessionId: entry.agentSessionId!, nativeSession: entry.nativeSession ?? null,
      }, signal);
    } catch (error) {
      releaseCapacity();
      throw error;
    }
    const release = () => { releaseCapacity(); service.release(operation); };
    const prepared = Object.freeze({
      validate,
      release: () => { if (this.#preparedTurns.delete(prepared)) release(); },
    });
    try {
      signal.throwIfAborted();
      validate();
      this.#preparedTurns.set(prepared, {
        chatId, kind, entry, selection, turn, service, operation, configurationInput, validateBinding, releaseCapacity, release,
      });
      return prepared;
    } catch (error) {
      release();
      throw error;
    }
  }

  startSession(chatId: string, prompt: string, opts: RunAgentTurnOptions & { projectPath?: string } = {}): Promise<void> {
    return this.#dispatchTurn(chatId, prompt, { ...opts, commandType: opts.commandType ?? 'chat-start' });
  }

  runAgentTurn(chatId: string, prompt: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    return this.#dispatchTurn(chatId, prompt, { ...opts, commandType: opts.commandType ?? 'agent-run' });
  }

  async #dispatchTurn(chatId: string, prompt: string, opts: RunAgentTurnOptions): Promise<void> {
    assertExecutionAdmissionOpen(opts);
    const ticket = opts.preparedExecution ?? await this.prepareTurn(chatId, opts,
      opts.executionAdmission?.signal ?? new AbortController().signal);
    const prepared = this.#preparedTurns.get(ticket);
    if (!prepared || prepared.chatId !== chatId || (opts.turnId && opts.turnId !== prepared.turn.turnId)) {
      if (prepared) ticket.release();
      throw new TypeError('Prepared execution turn is invalid');
    }
    this.#preparedTurns.delete(ticket);
    let occurrence: RuntimeExecutionOccurrence | null = null;
    try {
      // Admission fixes configuration; dispatch still fences changes to the owning session or view.
      prepared.validateBinding();
      const content = prepared.kind === 'compact' ? null : await this.#preparePrompt(chatId, prompt, opts, prepared.entry.projectPath);
      if (content && !content.dispatch) return;
      assertExecutionAdmissionOpen(opts);
      prepared.validateBinding();
      const { entry, turn, service, operation, selection } = prepared;
      this.#events.trackTurn(chatId, operationMetadata(turn));
      const producer = this.#producer(chatId);
      const runId = this.#ledger.beginRun(chatId, turn.turnId);
      prepared.releaseCapacity();
      occurrence = { service, operation, runId };
      this.#executions.set(chatId, occurrence);
      let carriedContext = null;
      if (prepared.kind === 'start' && content?.dispatch) {
        const outcome = await this.#createCarriedContext({
          chatId, entry,
          messages: this.#ledger.conversationMessages(chatId, content.excludedOrdinals),
          transcriptViewId: content.viewId, destinationPrompt: content.prompt,
          clientRequestId: opts.clientRequestId ?? null, signal: opts.executionAdmission?.signal,
        });
        assertExecutionAdmissionOpen(opts);
        prepared.validateBinding();
        const carryover = resolveCarryOverOutcome(outcome);
        if (carryover.notice) this.#ledger.appendCarryoverNotice(chatId, content.viewId, carryover.notice);
        carriedContext = carryover.context;
      }
      await service.dispatch(operation, {
        prompt: content?.dispatch ? content.outboundPrompt : prompt,
        attachments: content?.dispatch ? content.attachments : [], carriedContext,
      }, { output: producer.output, admission: opts.executionAdmission ?? {
        signal: new AbortController().signal, async markStarted() {},
      } });
      if (prepared.kind === 'start') {
        assertExecutionAdmissionOpen(opts);
        const current = this.#registry.getChat(chatId);
        if (!current) throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
        if (current.agentOwnershipEpoch === entry.agentOwnershipEpoch
          && isDeepStrictEqual(executionConfiguration(current), prepared.configurationInput)) {
          this.#registry.updateChat(chatId, {
            model: selection.model, apiProviderId: selection.apiProviderId,
            modelEndpointId: selection.endpointId, modelProtocol: selection.protocol,
          });
        }
      }
    } catch (error) {
      if (occurrence) this.#ledger.failRun(chatId, occurrence.runId, dispatchFailureDetail(error));
      throw error;
    } finally {
      prepared.release();
    }
  }

  #reserveStartCapacity(): () => void {
    const limit = getMaxSessions();
    if (limit > 0 && this.getRunningSessionCount() + this.#preparedStarts >= limit) {
      throw new DomainError('SESSION_LIMIT',
        `Session limit reached (${limit}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`, 429, true);
    }
    this.#preparedStarts += 1;
    let reserved = true;
    return () => {
      if (!reserved) return;
      reserved = false;
      this.#preparedStarts -= 1;
    };
  }

  async prepareSteerTarget(chatId: string, target: AgentSteerTarget | null): Promise<() => void> {
    const captured = target && this.#steerTargets.get(target);
    const validate = () => {
      if (!captured || this.#steerTargets.get(target!) !== captured || captured.chatId !== chatId
        || this.#executions.get(chatId) !== captured.occurrence || captured.runId !== captured.occurrence.runId
        || !this.#ledger.isRunActive(chatId, captured.runId)) {
        throw new DomainError('STEER_TURN_CHANGED', 'The active turn changed before steering could be prepared', 409);
      }
    };
    validate();
    if (!captured) throw new TypeError('Steering target is missing');
    if (captured.prepared) throw new TypeError('Steering target was already prepared');
    const { service, operation } = captured.occurrence;
    const prepared = await service.prepareSteer(operation, new AbortController().signal);
    validate();
    if (prepared.kind === 'unsupported') throw new DomainError('OPERATION_UNSUPPORTED', 'This agent does not support steering', 422);
    if (prepared.kind === 'unavailable') throw new DomainError('STEER_TURN_UNAVAILABLE', 'The active turn is no longer available for steering', 409);
    captured.prepared = prepared.target;
    return () => {
      validate();
      if (captured.prepared !== prepared.target) throw new TypeError('Prepared steering target changed');
    };
  }

  async steerInput(
    chatId: string, input: string, options: AgentSteerOptions, target: AgentSteerTarget | null,
    prepareDelivery: () => Promise<void>,
  ): Promise<AgentSteerResult> {
    const captured = target && this.#steerTargets.get(target);
    const current = () => captured && captured.chatId === chatId
      && this.#executions.get(chatId) === captured.occurrence
      && captured.occurrence.runId === captured.runId && this.#ledger.isRunActive(chatId, captured.runId);
    if (!captured || !current()) {
      return { kind: 'rejected', reason: 'turn-changed', message: 'The active execution changed before steering' };
    }
    const { service, operation } = captured.occurrence;
    const prepared = captured.prepared;
    if (!prepared) throw new TypeError('Steering target was not prepared before input admission');
    this.#steerTargets.delete(target!);
    return service.steer(operation, prepared, {
      input, clientMessageId: options.clientMessageId,
      prepareDelivery: async () => {
        if (!current()) throw new DomainError('STEER_TURN_CHANGED', 'The active turn changed before steering could be applied', 409);
        await prepareDelivery();
        this.#ledger.takePreparedInput(chatId, options.clientMessageId);
      },
    });
  }

  captureSteerTarget(chatId: string): AgentSteerTarget | null {
    const occurrence = this.#executions.get(chatId);
    if (!occurrence || !this.#ledger.isRunActive(chatId, occurrence.runId)) return null;
    const target = Object.freeze({});
    this.#steerTargets.set(target, { chatId, occurrence, runId: occurrence.runId, prepared: null });
    return target;
  }

  async submitGoalControl(
    chatId: string, prompt: string, opts: RunAgentTurnOptions,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>,
  ): Promise<boolean> {
    const occurrence = this.#executions.get(chatId);
    if (!occurrence || !this.#ledger.isRunActive(chatId, occurrence.runId)) return false;
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const selection = this.#resolveExecutionSelection(entry, entry, opts);
    const operation = operationIdentity(entry, opts, opts.commandType ?? 'agent-run');
    const previousTurn = this.#events.getActiveTurn(chatId);
    const previousRunId = occurrence.runId;
    return occurrence.service.submitGoalControl(occurrence.operation, {
      runId: operation.turnId, configuration: this.#configurationRequest(entry, selection, opts),
      prompt: await resolveFileMentionsInCommand(prompt, entry.projectPath), attachments: attachments(opts.images),
      beforeDelivery: async (handoff) => {
        await beforeDelivery(this.#goalRunHandoff({
          chatId, previousRunId, nextRunId: operation.turnId, previousTurn,
          nextTurn: operationMetadata(operation), downstream: handoff,
        }));
        this.#ledger.takePreparedInput(chatId, opts.clientMessageId);
      },
    }, opts.executionAdmission?.signal ?? new AbortController().signal);
  }

  compactSession(chatId: string, opts: {
    instructions?: string; clientRequestId?: string; turnId?: string;
    executionAdmission?: AgentExecutionAdmission; preparedExecution?: PreparedExecutionTurn;
  } = {}): Promise<void> {
    const prompt = opts.instructions?.trim() ? `/compact ${opts.instructions.trim()}` : '/compact';
    return this.#dispatchTurn(chatId, prompt, { ...opts, commandType: 'agent-compact' });
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    const entry = this.#registry.getChat(request.chatId);
    if (!entry) throw new Error(`Session not found: ${request.chatId}`);
    if (
      entry.agentId !== agentId
      || entry.agentSessionId !== request.agentSessionId
      || entry.projectPath !== request.previousProjectPath
    ) {
      throw new Error(`Session changed while preparing project path: ${request.chatId}`);
    }
    const integration = this.#instances.requireFor(entry);
    if (!integration.projectPathUpdates) return;
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
    const active = this.#executions.get(chatId);
    this.#ledger.interruptRun(chatId);
    if (active?.runId === runId) {
      void active.service.abort(active.operation).catch((error) => {
        logger.warn('Provider abort after accepted interruption failed', { chatId, reason: String(error) });
      });
    }
    return Promise.resolve(true);
  }

  isChatRunning(chatId: string): boolean {
    return this.#ledger.isRunActive(chatId);
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
    signal: AbortSignal;
  }): Promise<ForkedAgentSessionOutcome | null> {
    args.signal.throwIfAborted();
    if (
      args.messageOrdinal !== undefined
      && (!Number.isSafeInteger(args.messageOrdinal) || args.messageOrdinal <= 0)
    ) {
      throw new DomainError('VALIDATION_FAILED', 'messageOrdinal must be a positive safe integer', 400);
    }
    try {
      const source = requireAgentChatEntry(args.sourceChatId, args.sourceSession);
      const forking = this.#instances.nativeForkFor(source);
      if (!forking) return null;
      const selection = this.#endpointResolver.resolveSelection({
        agentId: source.agentId,
        model: source.model,
        apiProviderId: source.apiProviderId,
        modelEndpointId: source.modelEndpointId,
      });
      const result = await forking.fork({
        chatId: args.targetChatId,
        source: toProviderNativeChatReference(args.sourceChatId, source, this.#getCarryOverRevision(source)),
        configuration: {
          model: selection.model,
          permissionMode: source.permissionMode,
          thinkingMode: source.thinkingMode,
          settings: source.agentSettingsById?.[source.agentId] ?? null,
          endpoint: toAdmittedEndpoint(this.#endpointResolver, selection),
        },
        // A point fork must stay distinguishable from a whole-chat fork even
        // when the anchor row carries no provider identity: an empty object
        // reaches the facet's refusal path instead of forking the tip.
        providerMeta: args.messageOrdinal === undefined ? null : args.providerMeta ?? {},
      }, args.signal);
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
        // A missing source shares the refusal code so the handoff-consent flow
        // applies, but names the source rather than promising the row will settle.
        const forkReason = error.details?.nativeForkReason;
        if (forkReason === 'not-settled' || forkReason === 'source-missing') {
          throw new DomainError(
            'TRANSCRIPT_NOT_YET_PERSISTED',
            forkReason === 'source-missing'
              ? 'The agent\'s native session for this chat is unavailable right now. Retry, or fork without it.'
              : 'The selected message is not in the agent\'s native history yet. Try again shortly.',
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

  async discardForkedAgentSession(owner: LocatedChatOwner, session: StartedAgentSession): Promise<void> {
    const forking = this.#instances.nativeForkFor(owner);
    if (!forking) return;
    await forking.discard({ session }, new AbortController().signal);
  }

  async runSingleQuery(
    prompt: string,
    options: RunSingleQueryOptions,
  ): Promise<string> {
    const { agentId } = options;
    const target = this.#instances.defaultFor(this.#localNodeId, agentId);
    if (!target) throw new DomainError('NODE_UNAVAILABLE', 'The default local provider instance is unavailable.', 409);
    const singleQuery = this.#instances.singleQueryForInstance(target);
    if (!singleQuery) throw new Error(`Single query unsupported for agent: ${agentId}`);
    const model = typeof options.model === 'string' ? options.model : '';
    const selection = model ? this.#endpointResolver.resolveSelection({
      agentId,
      model,
      apiProviderId: typeof options.apiProviderId === 'string' ? options.apiProviderId : null,
      modelEndpointId: typeof options.modelEndpointId === 'string' ? options.modelEndpointId : null,
    }) : null;
    const signal = options.signal instanceof AbortSignal ? options.signal : new AbortController().signal;
    const projectPath = typeof options.projectPath === 'string'
      ? options.projectPath
      : typeof options.cwd === 'string' ? options.cwd : process.cwd();
    const timeoutMs = typeof options.timeoutMs === 'number'
      && Number.isFinite(options.timeoutMs)
      && options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
    return singleQuery.run({
      prompt,
      projectPath,
      configuration: {
        model: selection?.model ?? model,
        thinkingMode: options.thinkingMode,
        settings: isAgentSettingsEnvelope(options.agentSettings) ? options.agentSettings : null,
        endpoint: selection ? toAdmittedEndpoint(this.#endpointResolver, selection) : null,
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }, signal);
  }

  async discoverChatSlashCommands(chat: AgentChatEntry, agentId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.#instances.requireFor(chat);
    let target: ExecutionInstanceRef = chat.executionLocation;
    if (agentId !== chat.agentId) {
      // A staged provider change selects its default on the same node, never another machine.
      const staged = this.#instances.defaultFor(chat.executionLocation.nodeId, agentId);
      if (!staged) throw new DomainError('NODE_UNAVAILABLE', 'The selected provider is unavailable on this chat node.', 409);
      this.#instances.requireFor({
        agentId, executionLocation: { ...chat.executionLocation, instanceId: staged.instanceId },
      });
      target = staged;
    }
    const commands = await this.#instances.commandsForInstance(target).discover({ projectPath: chat.projectPath }, signal);
    signal.throwIfAborted();
    return [...commands];
  }

  async discoverDefaultSlashCommands(nodeId: string, agentId: string, projectPath: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const target = this.#instances.defaultFor(nodeId, agentId);
    if (!target) throw new DomainError('NODE_UNAVAILABLE', 'The default local provider instance is unavailable.', 409);
    const commands = await this.#instances.commandsForInstance(target).discover({ projectPath }, signal);
    signal.throwIfAborted();
    return [...commands];
  }

  #resolveExecutionSelection(
    persistedEntry: AgentChatEntry | null | undefined,
    entry: ReturnType<typeof requireAgentChatEntry>,
    opts: Pick<RunAgentTurnOptions, 'model' | 'apiProviderId' | 'modelEndpointId'>,
  ) {
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
    return selection;
  }

  #configurationRequest(
    entry: ReturnType<typeof requireAgentChatEntry>,
    selection: ReturnType<ApiProviderEndpointResolver['resolveSelection']>,
    opts: Pick<RunAgentTurnOptions, 'permissionMode' | 'thinkingMode' | 'agentSettings'>,
  ) {
    return {
      model: selection.model,
      permissionMode: opts.permissionMode ?? entry.permissionMode,
      thinkingMode: opts.thinkingMode ?? entry.thinkingMode,
      settings: opts.agentSettings ?? entry.agentSettingsById?.[entry.agentId] ?? null,
      endpoint: toAdmittedEndpoint(this.#endpointResolver, selection),
    };
  }

  async #preparePrompt(
    chatId: string,
    fallbackPrompt: string,
    opts: Pick<RunAgentTurnOptions, 'clientMessageId' | 'images'>,
    projectPath: string,
  ): Promise<PreparedPrompt> {
    const composition = this.#ledger.takePreparedInput(chatId, opts.clientMessageId);
    if (composition && !composition.inserted) {
      return { dispatch: false };
    }
    const viewId = composition?.input.viewId ?? this.#ledger.currentView(chatId)?.viewId;
    if (!viewId) throw new Error(`Transcript view is not initialized for ${chatId}`);
    const promptRows = composition?.prompt ?? [];
    const prompt = promptRows.length > 0
      ? promptRows.map((row) => row.detail.message.content).join('\n\n')
      : fallbackPrompt;
    const excluded = new Set(promptRows.map((row) => row.ordinal));
    const preparedAttachments = promptRows.length > 0
      ? promptRows.flatMap((row) => row.detail.attachments)
      : attachments(opts.images);
    const resolvedPrompt = await resolveFileMentionsInCommand(prompt, projectPath);
    return {
      dispatch: true,
      prompt: resolvedPrompt,
      outboundPrompt: `${composition?.providerPrefix ?? ''}${resolvedPrompt}`,
      attachments: [...preparedAttachments],
      excludedOrdinals: excluded,
      viewId,
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
        const active = this.#executions.get(input.chatId);
        if (active?.runId === input.previousRunId) {
          // The launch continuation retains this record before its native handle exists.
          active.runId = input.nextRunId;
        }
      },
    };
  }

  #producer(chatId: string): LocalProducerBinding {
    const existing = this.#producerLeases.get(chatId);
    if (existing && !existing.lease.closed) return existing;
    if (this.#hasPendingOwnershipTransfer(chatId)) throw ownershipTransferPendingError();
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const lease = this.#ledger.openProducer(chatId, entry.agentId);
    const binding = { lease, output: localEmissionSink(lease.sink) };
    this.#producerLeases.set(chatId, binding);
    return binding;
  }

  reopenProducer(chatId: string): void {
    this.#producerLeases.get(chatId)?.lease.close();
    this.#producerLeases.delete(chatId);
    this.#producer(chatId);
  }

  publishSessionFact(chatId: string, session: AgentEstablishedSession): void {
    this.#producer(chatId).lease.sink.publish({ type: 'session', session });
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

function isAgentSettingsEnvelope(value: unknown): value is AgentSettingsEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function executionBinding(entry: AgentChatEntry) {
  return structuredClone({
    agentId: entry.agentId, executionLocation: entry.executionLocation,
    projectPath: entry.projectPath, agentOwnershipEpoch: entry.agentOwnershipEpoch,
    agentSessionId: entry.agentSessionId ?? null, nativeSession: entry.nativeSession ?? null,
  });
}

function executionConfiguration(entry: AgentChatEntry) {
  return structuredClone({
    model: entry.model, apiProviderId: entry.apiProviderId ?? null, modelEndpointId: entry.modelEndpointId ?? null,
    modelProtocol: entry.modelProtocol ?? null,
    permissionMode: entry.permissionMode, thinkingMode: entry.thinkingMode,
    settings: entry.agentSettingsById?.[entry.agentId] ?? null,
  });
}

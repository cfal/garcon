import crypto from 'node:crypto';
import { effectiveExecutorId, LOCAL_EXECUTOR_ID } from '../../../common/executors.js';
import {
  AgentIntegrationError,
  AgentCallError,
  type AgentProjectPathUpdatePreparation,
  type AgentSteerResult,
  type AgentSteerTarget,
  type AgentExecutionHandle,
  type AgentEstablishedSession,
} from '@garcon/server-agent-interface';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { PermissionDecisionPayload } from '../../../common/chat-command-contracts.js';
import type { ChatTransientControlAction } from '../../../common/chat-transient-feed.js';
import {
  normalizePermissionMode,
  type ThinkingMode,
} from '../../../common/chat-modes.js';
import { normalizeSupportedThinkingMode } from '../../../common/execution-defaults.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import { assertSameApiProviderBoundary } from '../api-providers/endpoint-resolver.js';
import { getMaxSessions } from '../config.js';
import { createLogger } from '../../common/log.js';
import type { TurnReceiptOwner } from '../lib/turn-identity.js';
import { DomainError, transcriptUnavailableMessage } from '../../common/domain-error.js';
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
import { resolveCarryOverOutcome, type CarryOverOutcome } from '../chats/carryover-outcome.js';
import type {
  TranscriptLedgerService,
  TranscriptProducerLease,
} from '../ledger/service.js';
import type { TranscriptViewId } from '../ledger/contracts.js';
import {
  dispatchFailureDetail,
} from './runtime-router-errors.js';
import { ProducerBindings } from './producer-bindings.js';
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
  createCarriedContext(input: CreateCarriedContextInput): Promise<CarryOverOutcome>;
  ledger: TranscriptLedgerService;
  adoption: TranscriptAdoptionService;
  hasPendingOwnershipTransfer(chatId: string): boolean;
  resolveFileMentions(command: string, projectPath: string, executorId?: string | null): Promise<string>;
}

export interface CreateCarriedContextInput {
  readonly onCompactionStarted?: () => void;
  readonly chatId: string;
  readonly entry: AgentChatEntry;
  readonly messages: readonly ChatMessage[];
  readonly transcriptViewId: TranscriptViewId;
  readonly destinationPrompt: string;
  readonly clientRequestId: string | null;
  readonly signal?: AbortSignal;
}

export interface RunSingleQueryOptions {
  readonly executorId?: string | null;
  readonly agentId: string;
  readonly model?: string;
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
  readonly #endpointResolver: ApiProviderEndpointResolver;
  readonly #events: AgentEventBus;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #createCarriedContext: AgentRuntimeRouterOptions['createCarriedContext'];
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #resolveFileMentions: AgentRuntimeRouterOptions['resolveFileMentions'];
  readonly #hasPendingOwnershipTransfer: (chatId: string) => boolean;
  readonly #producerLeases = new Map<string, { readonly executorId: string; readonly lease: TranscriptProducerLease }>();
  readonly #executionHandles = new Map<string, {
    readonly agentId: string;
    readonly runId: string;
    readonly handle: AgentExecutionHandle;
  }>();
  readonly #pendingAbortRuns = new Set<string>();
  readonly #bindings = new ProducerBindings(
    (error) => logger.warn('Producer binding failed', error),
    (chatId, lease, error) => {
      if (this.#producerLeases.get(chatId)?.lease !== lease) return;
      const runId = this.#ledger.activeRunId(chatId);
      if (!runId) return;
      const active = this.#executionHandles.get(chatId);
      if (active) this.#abortHandleBestEffort(chatId, active.agentId, active.handle, 'publication failure');
      else this.#pendingAbortRuns.add(runKey(chatId, runId));
      this.#executionHandles.delete(chatId);
      this.#bindings.forgetRun(runId);
      this.#ledger.failRun(chatId, runId, error);
    },
  );

  constructor(options: AgentRuntimeRouterOptions) {
    this.#registry = options.registry;
    this.#directory = options.directory;
    this.#endpointResolver = options.endpointResolver;
    this.#events = options.events;
    this.#getCarryOverRevision = options.getCarryOverRevision;
    this.#createCarriedContext = options.createCarriedContext;
    this.#ledger = options.ledger;
    this.#adoption = options.adoption;
    this.#resolveFileMentions = options.resolveFileMentions;
    this.#hasPendingOwnershipTransfer = options.hasPendingOwnershipTransfer;
    this.#ledger.subscribe((event) => {
      if (event.type !== 'run-ended') return;
      if (this.#executionHandles.get(event.chatId)?.runId === event.runId) {
        this.#executionHandles.delete(event.chatId);
      }
    });
  }
  async startSession(chatId: string, prompt: string, opts: {
    onContextPreparation?: (phase: 'compacting-context' | 'starting-agent') => void;
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
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  } = {}): Promise<void> {
    let runId: string | null = null;
    let executionInvoked = false;
    try {
      assertExecutionAdmissionOpen(opts);
      if (getMaxSessions() > 0 && this.getRunningSessionCount() >= getMaxSessions()) {
        throw new DomainError(
          'SESSION_LIMIT',
          `Session limit reached (${getMaxSessions()}). Wait for existing sessions to complete or increase GARCON_MAX_SESSIONS.`,
          429,
          true,
        );
      }
      await this.#adoption.ensure(chatId, opts.executionAdmission?.signal);
      const persistedEntry = this.#registry.getChat(chatId);
      const entry = requireAgentChatEntryWithModel(chatId, persistedEntry, opts.model);
      const integration = this.#directory.require(entry.agentId, entry.executorId);
      const selection = this.#resolveExecutionSelection(persistedEntry, entry, opts);
      await this.#validateEndpoint(integration, selection);
      const prepared = await this.#preparePrompt(chatId, prompt, opts);
      assertExecutionAdmissionOpen(opts);
      if (!prepared.dispatch) return;
      const operation = operationIdentity(entry, opts, opts.commandType ?? 'chat-start');
      this.#events.trackTurn(chatId, operationMetadata(operation));
      const producer = this.#producer(chatId);
      runId = this.#ledger.beginRun(chatId, operation.turnId);
      assertExecutionAdmissionOpen(opts);
      const outcome = await this.#createCarriedContext({
        chatId,
        entry,
        messages: this.#ledger.conversationMessages(chatId, prepared.excludedOrdinals),
        transcriptViewId: prepared.viewId,
        destinationPrompt: prepared.prompt,
        clientRequestId: opts.clientRequestId ?? null,
        signal: opts.executionAdmission?.signal,
        ...(opts.onContextPreparation ? { onCompactionStarted: () => {
          assertExecutionAdmissionOpen(opts);
          opts.onContextPreparation?.('compacting-context');
        } } : {}),
      });
      assertExecutionAdmissionOpen(opts);
      const carryover = resolveCarryOverOutcome(outcome);
      if (carryover.notice) {
        this.#ledger.appendCarryoverNotice(chatId, prepared.viewId, carryover.notice);
      }
      opts.onContextPreparation?.('starting-agent');
      const request = {
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        producerBinding: await this.#bindings.bind(integration, chatId, producer),
        prompt: prepared.outboundPrompt,
        attachments: prepared.attachments,
        carriedContext: carryover.context,
      };
      assertExecutionAdmissionOpen(opts);
      this.#endpointResolver.resolveEndpointReference(selection);
      executionInvoked = true;
      const handle = await integration.execution.start(request, { signal: opts.executionAdmission?.signal });
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
      const failure = executionInvoked ? error : executionSetupFailure(error);
      this.#failDefiniteDispatch(chatId, runId, failure);
      throw failure;
    }
  }

  async runAgentTurn(
    chatId: string,
    prompt: string,
    opts: RunAgentTurnOptions = {},
  ): Promise<void> {
    let runId: string | null = null;
    let executionInvoked = false;
    try {
      assertExecutionAdmissionOpen(opts);
      await this.#adoption.ensure(chatId, opts.executionAdmission?.signal);
      const persistedEntry = this.#registry.getChat(chatId);
      const entry = requireAgentChatEntryWithModel(chatId, persistedEntry, opts.model);
      if (!entry.agentSessionId) {
        // The delegated start classifies its own dispatch outcome.
        return this.startSession(chatId, prompt, {
          ...opts,
          commandType: opts.commandType ?? 'agent-run',
        });
      }
      const selection = this.#resolveExecutionSelection(persistedEntry, entry, opts);
      const integration = this.#directory.require(entry.agentId, entry.executorId);
      await this.#validateEndpoint(integration, selection);
      const prepared = await this.#preparePrompt(chatId, prompt, opts);
      if (!prepared.dispatch) return;
      assertExecutionAdmissionOpen(opts);
      const operation = operationIdentity(entry, opts, opts.commandType ?? 'agent-run');
      this.#events.trackTurn(chatId, operationMetadata(operation));
      const producer = this.#producer(chatId);
      runId = this.#ledger.beginRun(chatId, operation.turnId);
      const request = {
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        producerBinding: await this.#bindings.bind(integration, chatId, producer),
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt: prepared.outboundPrompt,
        attachments: prepared.attachments,
      };
      assertExecutionAdmissionOpen(opts);
      this.#endpointResolver.resolveEndpointReference(selection);
      executionInvoked = true;
      const handle = await integration.execution.resume(request, { signal: opts.executionAdmission?.signal });
      await this.#retainOrAbortHandle(chatId, entry.agentId, runId, handle);
    } catch (error) {
      const failure = executionInvoked ? error : executionSetupFailure(error);
      this.#failDefiniteDispatch(chatId, runId, failure);
      throw failure;
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
    const integration = this.#directory.require(entry.agentId, entry.executorId);
    if (!integration.steering) {
      throw new DomainError(
        'OPERATION_UNSUPPORTED',
        'This agent does not support steering',
        422,
      );
    }
    await prepareDelivery();
    this.#ledger.takePreparedInput(chatId, options.clientMessageId);
    return integration.steering.steer({
      chatId,
      projectPath: entry.projectPath,
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      target,
      input,
      clientMessageId: options.clientMessageId,
    });
  }

  async captureSteerTarget(chatId: string): Promise<AgentSteerTarget | null> {
    const entry = this.#registry.getChat(chatId);
    if (!entry?.agentSessionId) return null;
    const integration = this.#directory.require(entry.agentId, entry.executorId);
    const steering = integration.steering;
    if (!steering) return null;
    const expectedRunId = this.#ledger.activeRunId(chatId);
    if (!expectedRunId) return null;
    const producerBinding = await this.#bindings.bind(integration, chatId, this.#producer(chatId));
    return steering.captureTarget({
      chatId,
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      producerBinding,
      expectedRunId,
    });
  }

  async compactSession(chatId: string, opts: {
    instructions?: string;
    clientRequestId?: string;
    turnId?: string;
    executionAdmission?: AgentExecutionAdmission;
  } = {}): Promise<void> {
    let runId: string | null = null;
    let executionInvoked = false;
    try {
      assertExecutionAdmissionOpen(opts);
      const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
      if (!entry.agentSessionId) throw new Error(`Session missing agent session ID: ${chatId}`);
      const integration = this.#directory.require(entry.agentId, entry.executorId);
      const selection = this.#endpointResolver.resolveSelection({
        executorId: entry.executorId,
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
      runId = this.#ledger.beginRun(chatId, operation.turnId);
      const request = {
        ...this.#executionContextV5(chatId, entry, selection, runId, opts),
        producerBinding: await this.#bindings.bind(integration, chatId, producer),
        agentSessionId: entry.agentSessionId,
        nativeSession: entry.nativeSession ?? null,
        prompt,
        attachments: [],
      };
      assertExecutionAdmissionOpen(opts);
      this.#endpointResolver.resolveEndpointReference(selection);
      executionInvoked = true;
      const handle = await compaction.compact(request, { signal: opts.executionAdmission?.signal });
      await this.#retainOrAbortHandle(chatId, entry.agentId, runId, handle);
    } catch (error) {
      const failure = executionInvoked ? error : executionSetupFailure(error);
      this.#failDefiniteDispatch(chatId, runId, failure);
      throw failure;
    }
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    const entry = this.#registry.getChat(request.chatId);
    if (!entry) throw new Error(`Session not found: ${request.chatId}`);
    const integration = this.#directory.require(agentId, entry.executorId);
    if (!integration.projectPathUpdates) return;
    if (
      entry.agentId !== agentId
      || entry.agentSessionId !== request.agentSessionId
      || entry.projectPath !== request.previousProjectPath
    ) {
      throw new Error(`Session changed while preparing project path: ${request.chatId}`);
    }
    const updates = integration.projectPathUpdates;
    const prepared = await updates.prepare({
      chat: toAgentChatReference(
        integration,
        request.chatId,
        { ...entry, nativeSession: request.nativeSession },
          this.#getCarryOverRevision(entry),
      ),
      nextProjectPath: request.nextProjectPath,
    });
    if (!prepared) return;
    return {
      ...(prepared.nativeSession === undefined ? {} : { nativeSession: prepared.nativeSession }),
      commit: () => updates.commit(prepared.preparation),
      rollback: () => updates.rollback(prepared.preparation),
    };
  }

  executionSessionLost(executorId = LOCAL_EXECUTOR_ID): void {
    const runs = this.#ledger.activeChatIds()
      .filter((chatId) => effectiveExecutorId(this.#registry.getChat(chatId)?.executorId) === executorId)
      .map((chatId) => ({ chatId, runId: this.#ledger.activeRunId(chatId)! }));
    const leases = [...this.#producerLeases].filter(([, producer]) => producer.executorId === executorId);
    for (const [chatId, active] of this.#executionHandles) {
      if (active.handle.executorId === executorId) this.#executionHandles.delete(chatId);
    }
    for (const { chatId, runId } of runs) {
      this.#pendingAbortRuns.delete(runKey(chatId, runId));
      this.#bindings.forgetRun(runId);
      try {
        this.#ledger.failRun(chatId, runId, {
          code: 'OUTCOME_UNKNOWN',
          message: 'Executor disconnected mid-turn. The turn may still be running on the executor. Reload from native history after it finishes to recover missing output.',
        });
      } catch (error) {
        logger.warn('Unable to record executor loss', {
          executorId, chatId, reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Closing a producer removes its active run, so terminal publication must precede closure.
    for (const [chatId, producer] of leases) {
      try {
        producer.lease.close();
      } catch (error) {
        logger.warn('Unable to close lost-executor producer', {
          executorId, chatId, reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.#producerLeases.get(chatId) === producer) this.#producerLeases.delete(chatId);
      }
    }
  }

  #failDefiniteDispatch(chatId: string, runId: string | null, error: unknown): void {
    if (!runId) return;
    this.#pendingAbortRuns.delete(runKey(chatId, runId));
    if (error instanceof AgentCallError && error.outcome === 'unknown') return;
    this.#bindings.forgetRun(runId);
    this.#ledger.failRun(chatId, runId, dispatchFailureDetail(error));
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

  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined, executorId?: string | null): boolean {
    if (!agentSessionId) return false;
    return this.#ledger.activeChatIds().some((chatId) => {
      const entry = this.#registry.getChat(chatId);
      return entry?.agentId === agentId && entry.agentSessionId === agentSessionId
        && effectiveExecutorId(entry.executorId) === effectiveExecutorId(executorId);
    });
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
    const entry = this.#registry.getChat(chatId);
    if (!entry) throw new AgentCallError('rejected', 'Permission chat no longer exists');
    const integration = this.#directory.require(entry.agentId, entry.executorId);
    const claim = this.#ledger.claimPermissionResolution(control);
    try {
      const response = claim.decision.response;
      if (response.executorId !== effectiveExecutorId(entry.executorId) || response.integrationId !== entry.agentId) {
        throw new AgentCallError('rejected', 'Permission belongs to another execution target');
      }
      await integration.permissions.respond({
        response: claim.decision.response, decision,
      });
    } catch (error) {
      if (error instanceof AgentCallError && error.outcome === 'not-dispatched') {
        this.#ledger.abandonPermissionResolution(claim);
      } else {
        this.#ledger.retirePermissionResolution(claim);
      }
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
    if (
      args.messageOrdinal !== undefined
      && (!Number.isSafeInteger(args.messageOrdinal) || args.messageOrdinal <= 0)
    ) {
      throw new DomainError('VALIDATION_FAILED', 'messageOrdinal must be a positive safe integer', 400);
    }
    try {
      const source = requireAgentChatEntry(args.sourceChatId, args.sourceSession);
      const integration = this.#directory.require(source.agentId, source.executorId);
      if (!integration.forking) return null;
      const selection = this.#endpointResolver.resolveSelection({
        executorId: source.executorId,
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
        signal: args.signal,
        source: sourceReference,
        // A point fork must stay distinguishable from a whole-chat fork even
        // when the anchor row carries no provider identity: an empty object
        // reaches the facet's refusal path instead of forking the tip.
        providerMeta: args.messageOrdinal === undefined ? null : args.providerMeta ?? {},
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

  async discardForkedAgentSession(agentId: string, session: StartedAgentSession, executorId?: string | null): Promise<void> {
    const forking = this.#directory.require(agentId, executorId).forking;
    if (!forking) return;
    await forking.discard(session, new AbortController().signal);
  }

  async runSingleQuery(
    prompt: string,
    options: RunSingleQueryOptions,
  ): Promise<string> {
    const { agentId } = options;
    const integration = this.#directory.require(agentId, options.executorId);
    if (!integration.singleQuery) throw new Error(`Single query unsupported for agent: ${agentId}`);
    const model = typeof options.model === 'string' ? options.model : '';
    const selection = model || options.apiProviderId || options.modelEndpointId ? this.#endpointResolver.resolveSelection({
      executorId: options.executorId,
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
      model: selection?.model ?? model,
      thinkingMode: normalizeSupportedThinkingMode(
        options.thinkingMode,
        integration.descriptor.supportedThinkingModes,
      ),
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

  async discoverSlashCommands(agentId: string, projectPath: string, executorId?: string | null) {
    const commands = this.#directory.list(executorId).find(integration => integration.descriptor.id === agentId)?.commands;
    return commands
      ? [...(await commands.discover(projectPath, new AbortController().signal))]
      : [];
  }

  #resolveExecutionSelection(
    persistedEntry: AgentChatEntry | null | undefined,
    entry: ReturnType<typeof requireAgentChatEntry>,
    opts: Pick<RunAgentTurnOptions, 'model' | 'apiProviderId' | 'modelEndpointId'>,
  ) {
    const previous = this.#endpointResolver.describePrevious({
      model: persistedEntry?.model || entry.model,
      apiProviderId: entry.apiProviderId,
      modelEndpointId: entry.modelEndpointId,
    });
    const selection = this.#endpointResolver.resolveSelection({
      executorId: entry.executorId,
      agentId: entry.agentId,
      model: opts.model ?? entry.model,
      apiProviderId: opts.apiProviderId !== undefined ? opts.apiProviderId : entry.apiProviderId,
      modelEndpointId:
        opts.modelEndpointId !== undefined ? opts.modelEndpointId : entry.modelEndpointId,
    });
    assertSameApiProviderBoundary(previous, selection);
    return selection;
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
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const resolvedPrompt = await this.#resolveFileMentions(prompt, entry.projectPath, entry.executorId);
    return {
      dispatch: true,
      prompt: resolvedPrompt,
      outboundPrompt: `${composition?.providerPrefix ?? ''}${resolvedPrompt}`,
      attachments: [...preparedAttachments],
      excludedOrdinals: excluded,
      viewId,
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
      void this.#directory.require(agentId, handle.executorId).execution.abort(handle).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  #producer(chatId: string): TranscriptProducerLease {
    const existing = this.#producerLeases.get(chatId);
    if (existing && !existing.lease.closed) return existing.lease;
    if (this.#hasPendingOwnershipTransfer(chatId)) throw ownershipTransferPendingError();
    const entry = requireAgentChatEntry(chatId, this.#registry.getChat(chatId));
    const lease = this.#ledger.openProducer(chatId, entry.agentId);
    this.#producerLeases.set(chatId, { executorId: effectiveExecutorId(entry.executorId), lease });
    return lease;
  }

  reopenProducer(chatId: string): void {
    this.#producerLeases.get(chatId)?.lease.close();
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
    const integration = this.#directory.require(entry.agentId, entry.executorId);
    const permissionMode = supportedValue(
      integration.descriptor.supportedPermissionModes,
      normalizePermissionMode(opts.permissionMode ?? entry.permissionMode),
      'default',
    );
    const thinkingMode = normalizeSupportedThinkingMode(
      opts.thinkingMode ?? entry.thinkingMode,
      integration.descriptor.supportedThinkingModes,
    );
    const settings = integration.settings.parse(
      opts.agentSettings
        ?? entry.agentSettingsById?.[entry.agentId]
        ?? integration.settings.defaults(),
    );
    if (opts.executionAdmission) this.#bindings.onStarted(runId, () => opts.executionAdmission!.markStarted());
    return {
      chatId,
      projectPath: entry.projectPath,
      model: selection.model,
      permissionMode,
      thinkingMode,
      settings,
      endpoint: toAgentEndpointSelection(this.#endpointResolver, selection),
      runId,
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

function executionSetupFailure(error: unknown): unknown {
  return error instanceof AgentCallError && error.outcome === 'unknown'
    ? new AgentCallError('not-dispatched', `Execution was not dispatched: ${error.message}`)
    : error;
}

function isAgentSettingsEnvelope(value: unknown): value is AgentSettingsEnvelope {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

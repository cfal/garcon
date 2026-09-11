import type {
  AgentGoalControlHandoff,
  AgentNativeSessionRef,
  AgentProjectPathUpdatePreparation,
  AgentSteerResult,
  AgentSteerTarget,
  AgentTranscriptSourceLocation,
} from '@garcon/server-agent-interface';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { LocatedChatOwner } from '@garcon/common/execution-location';
import type { ChatTransientControlAction } from '../../common/chat-transient-feed.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { AgentCommandImage } from '../../common/ws-requests.js';
import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';
import type { AgentAuthStatus, AgentReadiness } from '../../common/agent-execution.js';
import type { SlashCommand } from '../../common/slash-commands.js';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '../../common/agent-auth.js';
import type { IChatRegistry } from '../chats/store.js';
import type { CarryOverOutcome } from '../chats/carryover-outcome.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { IntegrationRegistry } from './integration-registry.js';
import type {
  AgentChatEntry,
  AgentExecutionAdmission,
  AgentExecutionCommandType,
  ForkedAgentSessionOutcome,
  AgentSessionSettingsPatch,
  AgentSteerOptions,
  PrepareProjectPathUpdateRequest,
  RunAgentTurnOptions,
  StartedAgentSession,
} from './session-types.js';
import { AgentCatalogService, type AgentModelQuery } from './catalog-service.js';
import { AgentAuthService } from './auth-service.js';
import type { AgentInstanceDirectory } from './instance-directory.js';
import { AgentDirectory } from './directory.js';
import { AgentEventBus, type TurnEventMetadata } from './event-bus.js';
import {
  AgentRuntimeRouter,
  type AgentRuntimeRouterOptions,
  type CreateCarriedContextInput,
  type RunSingleQueryOptions,
} from './runtime-router.js';
import { AgentSessionSettingsService } from './session-settings-service.js';
import { toProviderNativeChatReference } from './integration-chat-reference.js';
import { createLogger } from '../lib/log.js';
import type { UserMessage } from '@garcon/common/chat-types';
import type { UserInputAdmissionOptions } from '../chat-execution/types.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import { transcriptViewId } from '../ledger/contracts.js';
import type { TranscriptCommitEvent, TranscriptLedgerService } from '../ledger/service.js';
import type { PreambleService } from '../preambles/service.js';
import {
  assertPreambleSelectionComposition,
  resolvePreambleSelection,
} from '../preambles/selection.js';
import {
  PendingPreambleBoundary,
  samePreambleBoundary,
} from '../../common/preambles.js';
import { StaleTranscriptViewError, SubmissionConflictError } from '../ledger/errors.js';
import { DomainError } from '../lib/domain-error.js';
import { ownershipTransferPendingError } from './ownership-transfer-fence.js';
import { dispatchListenersSequentially } from './listener-dispatch.js';
import {
  isThinkingModeSupported,
  normalizeSupportedThinkingMode,
} from '../../common/execution-defaults.js';

const logger = createLogger('agents:registry');

export interface AgentRegistryServiceContract {
  hasAgent(agentId: string): boolean;
  supportsAuthLogin(agentId: string): boolean;
  supportsAuthLoginCompletion(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean;
  supportsForkAtMessage(agentId: string): boolean;
  supportsForkWhileRunning(agentId: string): boolean;
  supportsUpdateProjectPath(owner: LocatedChatOwner): boolean;
  requiresNativePathForProjectPathUpdate(owner: LocatedChatOwner): boolean;
  supportsImages(agentId: string): boolean;
  supportsFileAttachmentMimeType(agentId: string, mimeType: string): boolean;
  requiresStrictModelDiscovery(agentId: string): boolean;
  currentTranscriptViewId(chatId: string, signal?: AbortSignal): Promise<string>;
  hasMatchingInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions,
  ): boolean;
  publishSessionFact(chatId: string, session: StartedAgentSession): void;
  resendCandidates(chatId: string): readonly import('../../common/chat-view.js').ResendCandidate[];
  captureSteerTarget(chatId: string): AgentSteerTarget | null;
  steerInput(
    chatId: string,
    input: string,
    options: AgentSteerOptions,
    target: AgentSteerTarget | null,
    prepareDelivery: () => Promise<void>,
  ): Promise<AgentSteerResult>;
  submitGoalControl(
    chatId: string,
    command: string,
    opts: RunAgentTurnOptions,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>,
  ): Promise<boolean>;
  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>>;
  getRunningChatIdsSnapshot(): string[];
  startSession(chatId: string, command: string, opts?: StartSessionOptions): Promise<void>;
  forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageOrdinal?: number;
    signal: AbortSignal;
  }): Promise<ForkedAgentSessionOutcome | null>;
  discardForkedAgentSession(owner: LocatedChatOwner, session: StartedAgentSession): Promise<void>;
  compactSession(chatId: string, opts?: CompactSessionOptions): Promise<void>;
  getAgentAuthStatusMap(signal?: AbortSignal): Promise<Record<string, AgentAuthStatus>>;
  getAgentReadinessMap(authByAgent?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, AgentReadiness>>;
  getAgentAuthStatus(agentId: string, signal?: AbortSignal): Promise<AgentAuthStatus | null>;
  getAgentCatalogEntries(): Promise<AgentCatalogEntry[]>;
  getAgentCatalogEntry(agentId: string, query?: AgentModelQuery): Promise<AgentCatalogEntry | null>;
  assertExecutionModeSelectionSupported(agentId: string, selection: {
    readonly permissionMode?: PermissionMode;
    readonly thinkingMode?: ThinkingMode;
  }): void;
  normalizeThinkingModeForAgent(agentId: string, value: unknown): ThinkingMode;
  launchAgentAuthLogin(agentId: string): Promise<AgentAuthLoginLaunchResult>;
  completeAgentAuthLogin(agentId: string, sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult>;
  getAgentAuthLoginStatus(agentId: string, expectedSessionId?: string, signal?: AbortSignal): Promise<AgentAuthLoginStatus>;
  modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean>;
  runSingleQuery(prompt: string, options: RunSingleQueryOptions): Promise<string>;
  getChatSlashCommands(chat: AgentChatEntry, agentId: string, signal: AbortSignal): Promise<SlashCommand[]>;
  getDefaultSlashCommands(agentId: string, projectPath: string, signal: AbortSignal): Promise<SlashCommand[]>;
  resolvePermission(
    chatId: string,
    permissionOccurrenceId: string,
    decision: PermissionDecisionPayload,
    control: ChatTransientControlAction,
  ): Promise<void>;
  prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void>;
  resolveNativeSession(session: AgentChatEntry, chatId?: string, signal?: AbortSignal): Promise<AgentNativeSessionRef | null>;
  describeTranscriptSource(
    session: AgentChatEntry,
    chatId: string,
    signal?: AbortSignal,
  ): Promise<AgentTranscriptSourceLocation | null>;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry>;
}

interface StartSessionOptions {
  images?: AgentCommandImage[];
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  agentSettings?: RunAgentTurnOptions['agentSettings'];
  projectPath?: string;
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
  commandType?: AgentExecutionCommandType;
  executionAdmission?: AgentExecutionAdmission;
}

interface CompactSessionOptions {
  instructions?: string;
  clientRequestId?: string;
  turnId?: string;
  executionAdmission?: AgentExecutionAdmission;
}

type RegistryInstances = AgentRuntimeRouterOptions['instances']
  & Pick<AgentInstanceDirectory, 'require' | 'catalogForInstance' | 'authForInstance' | 'nativeSessionsFor'>;

export class AgentRegistry implements AgentRegistryServiceContract {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #instances: RegistryInstances;
  readonly #localNodeId: string;
  readonly #catalog: AgentCatalogService;
  readonly #auth: AgentAuthService;
  readonly #events: AgentEventBus;
  readonly #runtime: AgentRuntimeRouter;
  readonly #settings: AgentSessionSettingsService;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #hasPendingOwnershipTransfer: (chatId: string) => boolean;
  readonly #preambles: Pick<PreambleService, 'snapshot'>;
  readonly #selectionAdmissionLock: KeyedPromiseLock;
  readonly #transcriptListeners = new Set<(
    event: TranscriptCommitEvent,
  ) => void | Promise<void>>();

  reopenTranscriptProducer(chatId: string): void {
    this.#runtime.reopenProducer(chatId);
  }

  constructor(args: {
    registry: IChatRegistry;
    integrations: IntegrationRegistry;
    instances: RegistryInstances;
    localNodeId: string;
    endpointResolver: ApiProviderEndpointResolver;
    getCarryOverRevision(entry: AgentChatEntry): string;
    createCarriedContext(input: CreateCarriedContextInput): Promise<CarryOverOutcome>;
    onCarryOverChanged?: (chatId: string) => void | Promise<void>;
    chatMutationLock?: KeyedPromiseLock;
    ledger: TranscriptLedgerService;
    adoption: TranscriptAdoptionService;
    hasPendingOwnershipTransfer(chatId: string): boolean;
    preambles: Pick<PreambleService, 'snapshot'>;
    selectionAdmissionLock: KeyedPromiseLock;
  }) {
    this.#registry = args.registry;
    this.#getCarryOverRevision = args.getCarryOverRevision;
    this.#ledger = args.ledger;
    this.#adoption = args.adoption;
    this.#directory = new AgentDirectory(args.integrations);
    this.#instances = args.instances;
    this.#localNodeId = args.localNodeId;
    const defaultAgentIds = this.#directory.list().map((integration) => integration.descriptor.id);
    this.#catalog = new AgentCatalogService({
      instances: this.#instances,
      localNodeId: this.#localNodeId,
      defaultAgentIds,
      endpointResolver: args.endpointResolver,
    });
    this.#auth = new AgentAuthService({
      instances: this.#instances,
      localNodeId: this.#localNodeId,
      defaultAgentIds,
      hasEndpointModels: (agentId) => this.#catalog.hasEndpointModels(agentId),
    });
    this.#events = new AgentEventBus();
    this.#runtime = new AgentRuntimeRouter({
      registry: this.#registry,
      localNodeId: this.#localNodeId,
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
      events: this.#events,
      instances: this.#instances,
      getCarryOverRevision: args.getCarryOverRevision,
      createCarriedContext: args.createCarriedContext,
      ledger: this.#ledger,
      adoption: this.#adoption,
      hasPendingOwnershipTransfer: args.hasPendingOwnershipTransfer,
    });
    this.#hasPendingOwnershipTransfer = args.hasPendingOwnershipTransfer;
    this.#preambles = args.preambles;
    this.#selectionAdmissionLock = args.selectionAdmissionLock;
    this.#settings = new AgentSessionSettingsService({
      registry: this.#registry,
      instances: this.#instances,
      endpointResolver: args.endpointResolver,
      chatMutationLock: args.chatMutationLock,
    });
    this.#ledger.subscribeSessionCommitted((event) => {
      this.#registry.updateChat(event.chatId, {
        agentSessionId: event.row.detail.agentSessionId,
        nativeSession: event.row.detail.nativeSession,
        nativeSeedReceipt: event.row.detail.nativeSeedReceipt,
      });
    });
    this.#ledger.subscribe((event) => this.#onTranscriptCommit(event));
  }

  hasAgent(agentId: string): boolean { return this.#directory.has(agentId); }
  assertExecutionModeSelectionSupported(agentId: string, selection: {
    readonly permissionMode?: PermissionMode;
    readonly thinkingMode?: ThinkingMode;
  }): void {
    const descriptor = this.#directory.get(agentId)?.descriptor;
    if (!descriptor) throw new DomainError('UNSUPPORTED_AGENT', `Unsupported agent: ${agentId}`, 422);
    if (
      selection.permissionMode !== undefined
      && !descriptor.supportedPermissionModes.includes(selection.permissionMode)
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Permission mode ${selection.permissionMode} is not supported by ${agentId}`,
        422,
      );
    }
    if (
      selection.thinkingMode !== undefined
      && !isThinkingModeSupported(selection.thinkingMode, descriptor.supportedThinkingModes)
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Thinking mode ${selection.thinkingMode} is not supported by ${agentId}`,
        422,
      );
    }
  }
  normalizeThinkingModeForAgent(agentId: string, value: unknown): ThinkingMode {
    return normalizeSupportedThinkingMode(
      value,
      this.#directory.require(agentId).descriptor.supportedThinkingModes,
    );
  }
  supportsAuthLogin(agentId: string): boolean { return this.#auth.supportsLogin(agentId); }
  supportsAuthLoginCompletion(agentId: string): boolean { return this.#auth.supportsLoginCompletion(agentId); }
  supportsFork(agentId: string): boolean { return this.#directory.has(agentId); }
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean {
    const instance = this.#instances.defaultFor(this.#localNodeId, agentId);
    return instance ? this.#instances.singleQueryForInstance(instance)?.runsToolsWithoutPermission ?? false : false;
  }
  supportsForkAtMessage(agentId: string): boolean { return this.#directory.has(agentId); }
  supportsForkWhileRunning(agentId: string): boolean { return this.#directory.has(agentId); }
  supportsUpdateProjectPath(owner: LocatedChatOwner): boolean {
    return this.#instances.requireFor(owner).descriptor.supportsProjectPathUpdate;
  }
  requiresNativePathForProjectPathUpdate(owner: LocatedChatOwner): boolean {
    return this.#instances.requireFor(owner).descriptor.requiresNativePathForProjectPathUpdate;
  }
  supportsImages(agentId: string): boolean { return this.#directory.get(agentId)?.descriptor.supportsImages ?? false; }
  supportsFileAttachmentMimeType(agentId: string, mimeType: string): boolean {
    return this.#directory.get(agentId)?.attachments?.fileMimeTypes.includes(mimeType.toLowerCase()) ?? false;
  }

  requiresStrictModelDiscovery(agentId: string): boolean {
    return this.#catalog.requiresStrictModelDiscovery(agentId);
  }

  prepareTurn(chatId: string, options: RunAgentTurnOptions, signal: AbortSignal) {
    return this.#runtime.prepareTurn(chatId, options, signal);
  }

  startSession(chatId: string, command: string, opts: StartSessionOptions = {}): Promise<void> {
    return this.#runtime.startSession(chatId, command, opts);
  }
  runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    return this.#runtime.runAgentTurn(chatId, command, opts);
  }
  prepareSteerTarget(chatId: string, target: AgentSteerTarget | null): Promise<() => void> {
    return this.#runtime.prepareSteerTarget(chatId, target);
  }
  captureSteerTarget(chatId: string): AgentSteerTarget | null {
    return this.#runtime.captureSteerTarget(chatId);
  }
  steerInput(
    chatId: string,
    input: string,
    options: AgentSteerOptions,
    target: AgentSteerTarget | null,
    prepareDelivery: () => Promise<void>,
  ): Promise<AgentSteerResult> {
    return this.#runtime.steerInput(chatId, input, options, target, prepareDelivery);
  }
  submitGoalControl(
    chatId: string,
    command: string,
    opts: RunAgentTurnOptions,
    beforeDelivery: (handoff: AgentGoalControlHandoff) => Promise<void>,
  ): Promise<boolean> {
    return this.#runtime.submitGoalControl(chatId, command, opts, beforeDelivery);
  }
  abortSession(chatId: string): Promise<boolean> { return this.#runtime.abortSession(chatId); }
  compactSession(chatId: string, opts: CompactSessionOptions = {}): Promise<void> { return this.#runtime.compactSession(chatId, opts); }
  isChatRunning(chatId: string): boolean { return this.#runtime.isChatRunning(chatId); }
  getRunningSessions() { return this.#runtime.getRunningSessions(); }
  getRunningChatIdsSnapshot(): string[] { return this.#runtime.getRunningChatIdsSnapshot(); }
  getRunningSessionCount(): number { return this.#runtime.getRunningSessionCount(); }
  resolvePermission(
    chatId: string,
    permissionOccurrenceId: string,
    decision: PermissionDecisionPayload,
    control: ChatTransientControlAction,
  ): Promise<void> {
    return this.#runtime.resolvePermission(chatId, permissionOccurrenceId, decision, control);
  }
  prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    return this.#runtime.prepareProjectPathUpdate(agentId, request);
  }
  forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageOrdinal?: number;
    signal: AbortSignal;
  }) {
    return this.#runtime.forkAgentSession(args);
  }
  discardForkedAgentSession(owner: LocatedChatOwner, session: StartedAgentSession): Promise<void> {
    return this.#runtime.discardForkedAgentSession(owner, session);
  }
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch) {
    return this.#settings.updateSessionSettings(chatId, patch);
  }
  runSingleQuery(prompt: string, options: RunSingleQueryOptions) {
    return this.#runtime.runSingleQuery(prompt, options);
  }
  getChatSlashCommands(chat: AgentChatEntry, agentId: string, signal: AbortSignal): Promise<SlashCommand[]> {
    return this.#runtime.discoverChatSlashCommands(chat, agentId, signal);
  }

  getDefaultSlashCommands(agentId: string, projectPath: string, signal: AbortSignal): Promise<SlashCommand[]> {
    return this.#runtime.discoverDefaultSlashCommands(this.#localNodeId, agentId, projectPath, signal);
  }

  // Returns the preview from the authoritative conversational ledger fold.
  async getPreview(session: AgentChatEntry | null, chatId = ''): Promise<{
    preview: unknown;
  } | null> {
    if (!session?.agentId || !chatId) return null;
    await this.#adoption.ensure(chatId);
    const messages = this.#ledger.conversationMessages(chatId);
    const first = messages.find((message) => message.type === 'user-message') ?? messages[0];
    const last = messages.at(-1);
    if (!first || !last) return null;
    return {
      preview: {
        firstMessage: messageText(first),
        lastMessage: messageText(last),
        createdAt: first.timestamp || null,
        lastActivity: last.timestamp || null,
      },
    };
  }

  getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    return this.#catalog.getModels(agentId, query);
  }
  modelSupportsImages(input: Parameters<AgentCatalogService['modelSupportsImages']>[0]): Promise<boolean> {
    return this.#catalog.modelSupportsImages(input);
  }

  async resolveNativeSession(session: AgentChatEntry, chatId = '', signal = new AbortController().signal): Promise<AgentNativeSessionRef | null> {
    signal.throwIfAborted();
    if (!session.agentSessionId) return null;
    const nativeSessions = this.#instances.nativeSessionsFor(session);
    const reference = await nativeSessions.resolve({
      chat: toProviderNativeChatReference(chatId, session, this.#getCarryOverRevision(session)),
    }, signal);
    signal.throwIfAborted();
    return reference;
  }

  async describeTranscriptSource(
    session: AgentChatEntry,
    chatId: string,
    signal = new AbortController().signal,
  ): Promise<AgentTranscriptSourceLocation | null> {
    signal.throwIfAborted();
    try {
      const source = await this.#instances.nativeSessionsFor(session).describe({
        chat: toProviderNativeChatReference(chatId, session, this.#getCarryOverRevision(session)),
      }, signal);
      signal.throwIfAborted();
      return source;
    } catch {
      signal.throwIfAborted();
      logger.warn('Transcript source description failed.', {
        code: 'TRANSCRIPT_SOURCE_DESCRIPTION_FAILED',
        integrationId: session.agentId,
      });
      return null;
    }
  }

  launchAgentAuthLogin(agentId: string): Promise<AgentAuthLoginLaunchResult> {
    return this.#auth.launchLogin(agentId);
  }
  completeAgentAuthLogin(agentId: string, sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult> {
    return this.#auth.completeLogin(agentId, sessionId, code);
  }
  getAgentAuthLoginStatus(agentId: string, expectedSessionId?: string, signal = new AbortController().signal): Promise<AgentAuthLoginStatus> {
    return this.#auth.loginStatus(agentId, expectedSessionId ?? null, signal);
  }
  getAgentAuthStatus(agentId: string, signal = new AbortController().signal): Promise<AgentAuthStatus | null> {
    return this.#auth.status(agentId, signal);
  }
  getAgentAuthStatusMap(signal = new AbortController().signal): Promise<Record<string, AgentAuthStatus>> {
    return this.#auth.statusMap(signal);
  }
  getAgentReadinessMap(authByAgent?: Record<string, unknown>, signal = new AbortController().signal): Promise<Record<string, AgentReadiness>> {
    return this.#auth.readinessMap(authByAgent, signal);
  }

  onSessionCreated(cb: (chatId: string) => void | Promise<void>): void { this.#events.onSessionCreated(cb); }
  onFinished(cb: Parameters<AgentEventBus['onFinished']>[0]): void { this.#events.onFinished(cb); }
  onFailed(cb: (
    chatId: string,
    error: string,
    errorCode: string,
    metadata?: TurnEventMetadata,
  ) => void | Promise<void>): void { this.#events.onFailed(cb); }
  settleTurn(chatId: string, turn: TurnEventMetadata): void { this.#events.settleTurn(chatId, turn); }
  discardTurn(chatId: string): void { this.#events.clearTurn(chatId); }
  getActiveTurn(chatId: string): TurnEventMetadata | undefined { return this.#events.getActiveTurn(chatId); }
  onTranscriptCommitted(listener: (event: TranscriptCommitEvent) => void | Promise<void>): void {
    this.#transcriptListeners.add(listener);
  }

  async currentTranscriptViewId(chatId: string, signal?: AbortSignal): Promise<string> {
    return (await this.#adoption.ensure(chatId, signal)).viewId;
  }

  publishSessionFact(chatId: string, session: StartedAgentSession): void {
    this.#runtime.publishSessionFact(chatId, session);
  }

  resendCandidates(chatId: string) {
    return this.#ledger.resendCandidates(chatId);
  }

  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void {
    this.#ledger.discardPreparedInput(chatId, clientMessageId);
  }

  async admitInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
  ): Promise<{ readonly inserted: boolean }> {
    // Direct admission shares the narrow selection/admission lock with Save so
    // an input can never observe a new selection before its update-notice
    // attempt, and Save can never interleave inside this commit.
    const view = await this.#adoption.ensure(chatId);
    return this.#selectionAdmissionLock.runExclusive(`chat:${chatId}`, async () => {
      const session = this.#registry.getChat(chatId);
      if (!session) throw new Error(`Session not initialized: ${chatId}`);
      this.#validateInputAdmission(chatId, session, options);
      return this.#commitInput(chatId, message, options, view.viewId);
    });
  }

  hasMatchingInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions,
  ): boolean {
    if (!this.#registry.getChat(chatId)) return false;
    const current = this.#ledger.existingCurrentView(chatId);
    if (!current) return false;
    try {
      return this.#ledger.hasMatchingInputSubmission({
        chatId,
        viewId: options.transcriptViewId
          ? transcriptViewId(options.transcriptViewId)
          : current.viewId,
        message,
        attachments: inputAttachments(options),
        clientMessageId: options.clientMessageId ?? null,
        steer: options.commandType === 'steer',
      });
    } catch (error) {
      throw mapInputSubmissionError(error);
    }
  }

  admitQueuedInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
  ): { readonly inserted: boolean } {
    const session = this.#registry.getChat(chatId);
    if (!session) throw new Error(`Session not initialized: ${chatId}`);
    this.#validateInputAdmission(chatId, session, options);
    const view = this.#ledger.currentView(chatId);
    if (!view) throw new Error(`Transcript view is not initialized for ${chatId}`);
    return this.#commitInput(chatId, message, options, view.viewId);
  }

  #commitInput(
    chatId: string,
    message: UserMessage,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
    currentViewId: ReturnType<typeof transcriptViewId>,
  ): { readonly inserted: boolean } {
    const session = this.#registry.getChat(chatId);
    if (!session) throw new Error(`Session not initialized: ${chatId}`);
    const pending = options.commandType === 'steer' || options.commandType === 'goal-control'
      ? null
      : session.pendingPreambleBoundary ?? null;
    const alreadyConsumed = pending
      ? this.#ledger.hasPreambleBoundaryProof(chatId, pending)
      : false;
    const boundary = pending && !alreadyConsumed ? pending : null;
    const viewId = options.transcriptViewId ? transcriptViewId(options.transcriptViewId) : currentViewId;
    const attachments = inputAttachments(options);
    const slashLeading = message.content.trimStart().startsWith('/');
    let composition;
    try {
      // Same-ID retries must return the original committed outcome without
      // resolving newer selection or catalog state, so the duplicate check
      // runs ahead of catalog resolution for every pending-boundary input,
      // not only slash commands. A later catalog change that makes the
      // current selection unsafe cannot turn an identical retry into a new
      // rejection (ledger L4).
      if (this.#ledger.hasMatchingInputSubmission({
        chatId,
        viewId,
        message,
        attachments,
        clientMessageId: options.clientMessageId ?? null,
        steer: options.commandType === 'steer',
      })) {
        // The early return must not leave a proven-consumed stale boundary
        // armed; repair the registry the same way the ordinary path would.
        if (alreadyConsumed && pending) this.#clearProvenPendingBoundary(chatId, pending);
        return { inserted: false };
      }
      options.validateBeforeCommit?.();
      // Application resolves the chat's saved order against one catalog
      // snapshot; unavailable entries are skipped, and the exact eligible
      // composition is proven safe immediately before the input commits.
      const preambles = boundary
        ? resolvePreambleSelection(
          session.preambleSelection,
          this.#preambles.snapshot(),
          session.projectPath,
        ).eligible
        : [];
      if (boundary && preambles.length > 0 && slashLeading) {
        throw new DomainError(
          'PREAMBLE_SLASH_COMMAND_BLOCKED',
          'Matching preambles haven\u2019t been sent yet. Start with a regular message before using provider slash commands.',
          422,
        );
      }
      if (boundary) assertPreambleSelectionComposition(chatId, preambles);
      composition = this.#ledger.appendInputAndCompose({
        chatId,
        viewId,
        message,
        attachments,
        clientMessageId: options.clientMessageId ?? null,
        steer: options.commandType === 'steer',
        preambleBoundary: boundary,
        preambles,
        ...(options.excludedResendOrdinals?.length
          ? { excludedOrdinals: new Set(options.excludedResendOrdinals) }
          : {}),
      });
    } catch (error) {
      throw mapInputSubmissionError(error);
    }
    if (pending && (alreadyConsumed || composition.inserted)) {
      this.#clearProvenPendingBoundary(chatId, pending);
    }
    return { inserted: composition.inserted };
  }

  // Compare-and-clear: never clears a boundary a newer ownership epoch or
  // selection revision replaced.
  #clearProvenPendingBoundary(
    chatId: string,
    consumed: PendingPreambleBoundary,
  ): void {
    const current = this.#registry.getChat(chatId);
    const currentBoundary = current?.pendingPreambleBoundary ?? null;
    if (currentBoundary && samePreambleBoundary(currentBoundary, consumed)) {
      this.#registry.updateChat(chatId, { pendingPreambleBoundary: null });
    }
  }

  async #onTranscriptCommit(event: TranscriptCommitEvent): Promise<void> {
    await dispatchListenersSequentially(this.#transcriptListeners, [event], (error) => {
      logger.error('Transcript listener failed', {
        chatId: event.chatId,
        event: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (event.type === 'session') {
      await this.#events.publishSession(event.chatId);
    } else if (event.type === 'run-ended') {
      await this.#events.publishRunEnded(event.chatId, event.runId, event.row);
    }
  }

  #validateInputAdmission(
    chatId: string,
    session: AgentChatEntry,
    options: UserInputAdmissionOptions & { readonly clientRequestId: string },
  ): void {
    if (this.#hasPendingOwnershipTransfer(chatId)) throw ownershipTransferPendingError();
    const commandType = options.commandType
      ?? (session.agentSessionId ? 'agent-run' : 'chat-start');
    if (commandType === 'agent-compact') {
      throw new TypeError('Compaction does not admit a transcript input');
    }
    if (commandType === 'steer') {
      const active = this.#events.getActiveTurn(chatId);
      if (!active?.turnId) throw new Error('Cannot admit a steer without an active turn');
      return;
    }
    if (!options.turnId) throw new TypeError('Accepted input is missing a turn ID');
  }

  getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}) { return this.#catalog.getAgentCatalogEntry(agentId, query); }
  getAgentCatalogEntries() { return this.#catalog.getAgentCatalogEntries(); }
}

function inputAttachments(options: UserInputAdmissionOptions) {
  return (options.images ?? []).map((image) => ({
    kind: 'image' as const,
    data: image.data,
    name: image.name ?? null,
    mimeType: image.mimeType ?? 'application/octet-stream',
  }));
}

function mapInputSubmissionError(error: unknown): unknown {
  if (error instanceof StaleTranscriptViewError) {
    return new DomainError('STALE_TRANSCRIPT_VIEW', error.message, 409, false, { cause: error });
  }
  if (error instanceof SubmissionConflictError) {
    return new DomainError('IDEMPOTENCY_CONFLICT', error.message, 409, false, { cause: error });
  }
  return error;
}

function messageText(message: ChatMessage): string {
  return 'content' in message && typeof message.content === 'string'
    ? message.content
    : message.type;
}

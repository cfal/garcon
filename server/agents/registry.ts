import type {
  AgentGoalControlHandoff,
  AgentNativeSessionRef,
  AgentProjectPathUpdatePreparation,
  AgentSteerResult,
  AgentSteerTarget,
  AgentTranscriptPage,
  AgentTranscriptSourceLocation,
  AgentInputPreparation,
  AgentTranscriptAdmissionIdentity,
  AgentChatReferenceV4,
  AgentIntegrationV4,
  AgentStreamEvent,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { AgentCommandImage } from '../../common/ws-requests.js';
import type { AgentCatalogEntry, AgentModelOption } from '../../common/agents.js';
import type { SlashCommand } from '../../common/slash-commands.js';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '../../common/agent-auth.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { transcriptRevision } from '../lib/transcript-revision.js';
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
import { AgentDirectory } from './directory.js';
import { AgentEventBus, type TurnEventMetadata } from './event-bus.js';
import { AgentRuntimeRouter, type RunSingleQueryOptions } from './runtime-router.js';
import { AgentSessionSettingsService } from './session-settings-service.js';
import { toAgentChatReference } from './integration-chat-reference.js';
import { createLogger } from '../lib/log.js';
import { AgentProjectionIngress } from './projection-ingress.js';
import type { UserMessage } from '@garcon/common/chat-types';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import type { PendingUserInputRegistrationOptions } from '../chat-execution/types.js';

const logger = createLogger('agents:registry');

export interface AgentRegistryServiceContract {
  hasAgent(agentId: string): boolean;
  supportsAuthLogin(agentId: string): boolean;
  supportsAuthLoginCompletion(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean;
  supportsForkAtMessage(agentId: string): boolean;
  supportsForkWhileRunning(agentId: string): boolean;
  supportsUpdateProjectPath(agentId: string): boolean;
  requiresNativePathForProjectPathUpdate(agentId: string): boolean;
  supportsImages(agentId: string): boolean;
  supportsFileAttachmentMimeType(agentId: string, mimeType: string): boolean;
  requiresStrictModelDiscovery(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
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
    messageSequence?: number;
  }): Promise<ForkedAgentSessionOutcome | null>;
  discardForkedAgentSession(agentId: string, session: StartedAgentSession): Promise<void>;
  compactSession(chatId: string, opts?: CompactSessionOptions): Promise<void>;
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(authByAgent?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAgentAuthStatus(agentId: string): Promise<unknown | null>;
  getAgentCatalogEntries(): Promise<AgentCatalogEntry[]>;
  getAgentCatalogEntry(agentId: string, query?: AgentModelQuery): Promise<AgentCatalogEntry | null>;
  launchAgentAuthLogin(agentId: string): Promise<AgentAuthLoginLaunchResult>;
  completeAgentAuthLogin(agentId: string, sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult>;
  getAgentAuthLoginStatus(agentId: string, expectedSessionId?: string): Promise<AgentAuthLoginStatus>;
  modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean>;
  runSingleQuery(prompt: string, options: RunSingleQueryOptions): Promise<string>;
  getSlashCommands(agentId: string, projectPath: string): Promise<SlashCommand[]>;
  resolvePermission(
    chatId: string,
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): Promise<void>;
  prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void>;
  resolveNativeSession(session: AgentChatEntry, chatId?: string): Promise<AgentNativeSessionRef | null>;
  describeTranscriptSource(
    session: AgentChatEntry,
    chatId: string,
  ): Promise<AgentTranscriptSourceLocation | null>;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry>;
}

type MutableAgentTranscriptPage = Omit<AgentTranscriptPage, 'messages'> & { messages: ChatMessage[] };

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

export class AgentRegistry implements AgentRegistryServiceContract {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #catalog: AgentCatalogService;
  readonly #events: AgentEventBus;
  readonly #projection: AgentProjectionIngress;
  readonly #runtime: AgentRuntimeRouter;
  readonly #settings: AgentSessionSettingsService;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;

  constructor(args: {
    registry: IChatRegistry;
    integrations: IntegrationRegistry;
    endpointResolver: ApiProviderEndpointResolver;
    getCarryOverRevision(entry: AgentChatEntry): string;
    loadCarriedContext(
      chatId: string,
      entry: AgentChatEntry,
      signal?: AbortSignal,
    ): Promise<CarriedContext | null>;
    getCarryOverMessageCount(entry: AgentChatEntry, signal?: AbortSignal): Promise<number>;
    onCarryOverChanged?: (chatId: string) => void | Promise<void>;
    chatMutationLock?: KeyedPromiseLock;
  }) {
    this.#registry = args.registry;
    this.#getCarryOverRevision = args.getCarryOverRevision;
    this.#directory = new AgentDirectory(args.integrations);
    this.#catalog = new AgentCatalogService({
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
    });
    this.#projection = new AgentProjectionIngress(this.#directory.list());
    this.#events = new AgentEventBus(this.#projection);
    this.#runtime = new AgentRuntimeRouter({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
      events: this.#events,
      projection: this.#projection,
      getCarryOverRevision: args.getCarryOverRevision,
        loadCarriedContext: args.loadCarriedContext,
        getCarryOverMessageCount: args.getCarryOverMessageCount,
      onCarryOverChanged: args.onCarryOverChanged,
    });
    this.#settings = new AgentSessionSettingsService({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
      chatMutationLock: args.chatMutationLock,
    });
  }

  hasAgent(agentId: string): boolean { return this.#directory.has(agentId); }
  supportsAuthLogin(agentId: string): boolean { return Boolean(this.#directory.get(agentId)?.auth?.launchLogin); }
  supportsAuthLoginCompletion(agentId: string): boolean { return Boolean(this.#directory.get(agentId)?.auth?.completeLogin); }
  supportsFork(agentId: string): boolean { return this.#directory.get(agentId)?.forking !== null; }
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean {
    return this.#directory.get(agentId)?.singleQuery?.runsToolsWithoutPermission ?? false;
  }
  supportsForkAtMessage(agentId: string): boolean { return this.#directory.get(agentId)?.forking?.supportsAtMessage ?? false; }
  supportsForkWhileRunning(agentId: string): boolean { return this.#directory.get(agentId)?.forking?.supportsWhileRunning ?? false; }
  supportsUpdateProjectPath(agentId: string): boolean { return this.#directory.get(agentId)?.descriptor.supportsProjectPathUpdate ?? false; }
  requiresNativePathForProjectPathUpdate(agentId: string): boolean {
    return this.#directory.get(agentId)?.descriptor.requiresNativePathForProjectPathUpdate ?? false;
  }
  supportsImages(agentId: string): boolean { return this.#directory.get(agentId)?.descriptor.supportsImages ?? false; }
  supportsFileAttachmentMimeType(agentId: string, mimeType: string): boolean {
    return this.#directory.get(agentId)?.attachments?.fileMimeTypes.includes(mimeType.toLowerCase()) ?? false;
  }

  requiresStrictModelDiscovery(agentId: string): boolean {
    return this.#catalog.requiresStrictModelDiscovery(agentId);
  }

  startSession(chatId: string, command: string, opts: StartSessionOptions = {}): Promise<void> {
    return this.#runtime.startSession(chatId, command, opts);
  }
  runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    return this.#runtime.runAgentTurn(chatId, command, opts);
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
  waitUntilTurnAbortable(chatId: string, turn: TurnEventMetadata, signal?: AbortSignal): Promise<boolean> {
    return this.#events.waitUntilTurnAbortable(chatId, turn, signal);
  }
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean {
    return this.#runtime.isAgentSessionRunning(agentId, agentSessionId);
  }
  getRunningSessions() { return this.#runtime.getRunningSessions(); }
  getRunningChatIdsSnapshot(): string[] { return this.#runtime.getRunningChatIdsSnapshot(); }
  getRunningSessionCount(): number { return this.#runtime.getRunningSessionCount(); }
  resolvePermission(
    chatId: string,
    permissionRequestId: string,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    return this.#runtime.resolvePermission(chatId, permissionRequestId, decision);
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
    messageSequence?: number;
  }) {
    return this.#runtime.forkAgentSession(args);
  }
  discardForkedAgentSession(agentId: string, session: StartedAgentSession): Promise<void> {
    return this.#runtime.discardForkedAgentSession(agentId, session);
  }
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch) {
    return this.#settings.updateSessionSettings(chatId, patch);
  }
  runSingleQuery(prompt: string, options: RunSingleQueryOptions) {
    return this.#runtime.runSingleQuery(prompt, options);
  }
  getSlashCommands(agentId: string, projectPath: string): Promise<SlashCommand[]> {
    return this.#runtime.discoverSlashCommands(agentId, projectPath);
  }

  async getPreview(session: AgentChatEntry | null, chatId = ''): Promise<unknown> {
    if (!session?.agentId) return null;
    const integration = this.#directory.get(session.agentId);
    if (!integration) return null;
    const result = await integration.transcript.preview({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session)),
      signal: new AbortController().signal,
    });
    return result.kind === 'ready' ? result.value : null;
  }

  async loadMessages(session: AgentChatEntry | null, chatId = ''): Promise<ChatMessage[]> {
    return [...(await this.loadTranscriptSnapshot(session, chatId)).messages];
  }

  async loadTranscriptSnapshot(
    session: AgentChatEntry | null,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ) {
    if (!session?.agentId) return { messages: [], revision: transcriptRevision([]) };
    const integration = this.#directory.get(session.agentId);
    if (!integration) return { messages: [], revision: transcriptRevision([]) };
    const chat = toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session));
    const opened = await this.#projection.open(integration, chat, signal);
    if (opened.kind !== 'ready') return { messages: [], revision: transcriptRevision([]) };
    const messages = opened.value.entries.map((entry) => entry.message);
    return { messages, revision: transcriptRevision(messages) };
  }

  async loadMessagePage(
    session: AgentChatEntry | null,
    limit: number,
    offset: number,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MutableAgentTranscriptPage | null> {
    if (!session?.agentId) return null;
    const integration = this.#directory.get(session.agentId);
    if (!integration) return null;
    const chat = toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session));
    const opened = await this.#projection.open(integration, chat, signal);
    if (opened.kind !== 'ready') return null;
    const total = opened.value.checkpoint.projection.total;
    const page = await this.#projection.page({
      integration,
      chat,
      signal,
      limit,
      beforeOrdinal: Math.max(1, total - offset + 1),
      expectedProjection: opened.value.checkpoint.projection,
    });
    if (page.kind !== 'ready') return null;
    const messages = page.page.entries.map((entry) => entry.message);
    return {
      messages,
      total,
      hasMore: page.page.hasMore,
      offset,
      limit,
      revision: transcriptRevision(opened.value.entries.map((entry) => entry.message)),
    };
  }

  getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    return this.#catalog.getModels(agentId, query);
  }
  modelSupportsImages(input: Parameters<AgentCatalogService['modelSupportsImages']>[0]): Promise<boolean> {
    return this.#catalog.modelSupportsImages(input);
  }

  async resolveNativeSession(session: AgentChatEntry, chatId = ''): Promise<AgentNativeSessionRef | null> {
    if (!session.agentSessionId) return null;
    const integration = this.#directory.get(session.agentId);
    if (!integration) return null;
    const result = await integration.transcript.resolveNativeSession({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session)),
      signal: new AbortController().signal,
    });
    if (result.kind !== 'ready') return null;
    const reference = result.value;
    if (reference?.ownerId !== session.agentId && reference !== null) {
      throw new Error(`Native session owner mismatch for ${chatId || session.agentSessionId}`);
    }
    return reference;
  }

  async describeTranscriptSource(
    session: AgentChatEntry,
    chatId: string,
  ): Promise<AgentTranscriptSourceLocation | null> {
    const integration = this.#directory.get(session.agentId);
    if (!integration) return null;
    try {
      const result = await integration.transcript.describeSource({
        chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session)),
        signal: new AbortController().signal,
      });
      if (result.kind !== 'ready') return null;
      const source = result.value;
      if (source === null) return null;
      if ((source.kind !== 'filesystem-path' && source.kind !== 'provider-reference')
          || typeof source.value !== 'string' || source.value.length === 0) {
        throw new Error('INVALID_TRANSCRIPT_SOURCE_DESCRIPTION');
      }
      return source;
    } catch {
      logger.warn('Transcript source description failed.', {
        code: 'TRANSCRIPT_SOURCE_DESCRIPTION_FAILED',
        integrationId: session.agentId,
      });
      return null;
    }
  }

  async launchAgentAuthLogin(agentId: string): Promise<AgentAuthLoginLaunchResult> {
    const auth = this.#directory.require(agentId).auth;
    if (!auth?.launchLogin) throw new Error(`Auth login is not supported for agent: ${agentId}`);
    return auth.launchLogin();
  }
  async completeAgentAuthLogin(agentId: string, sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult> {
    const complete = this.#directory.require(agentId).auth?.completeLogin;
    if (!complete) throw new Error(`Auth login completion is not supported for agent: ${agentId}`);
    return complete(sessionId, code);
  }
  async getAgentAuthLoginStatus(agentId: string, expectedSessionId?: string): Promise<AgentAuthLoginStatus> {
    return this.#directory.require(agentId).auth?.loginStatus?.(expectedSessionId)
      ?? { state: 'idle', running: false };
  }
  async getAgentAuthStatus(agentId: string): Promise<unknown | null> {
    const auth = this.#directory.get(agentId)?.auth;
    return auth ? auth.status(new AbortController().signal) : null;
  }
  async getAgentAuthStatusMap(): Promise<Record<string, unknown>> {
    return Object.fromEntries(await Promise.all(this.#directory.list().map(async (integration) => [
      integration.descriptor.id,
      integration.auth
        ? await integration.auth.status(new AbortController().signal)
        : { authenticated: false, canReauth: false, label: integration.descriptor.label, source: 'none' },
    ])));
  }
  async getAgentReadinessMap(authByAgent?: Record<string, unknown>) {
    const auth = authByAgent ?? await this.getAgentAuthStatusMap();
    return Object.fromEntries(this.#directory.list().map((integration) => {
      const status = auth[integration.descriptor.id] as { authenticated?: boolean } | undefined;
      const nativeReady = status?.authenticated === true;
      const endpointReady = integration.endpoints !== null
        && this.#catalog.hasEndpointModels(integration.descriptor.id);
      return [integration.descriptor.id, {
        ready: nativeReady || endpointReady,
        nativeReady,
        endpointReady,
        reason: endpointReady
          ? 'At least one compatible API provider endpoint is configured.'
          : nativeReady
            ? 'Native agent authentication is available.'
            : 'No native authentication or compatible API provider endpoint is configured.',
      }];
    }));
  }

  onMessages(cb: (chatId: string, messages: ChatMessage[], metadata?: TurnEventMetadata) => void | Promise<void>): void { this.#events.onMessages(cb); }
  onProcessing(cb: (chatId: string, processing: boolean) => void | Promise<void>): void { this.#events.onProcessing(cb); }
  onSessionCreated(cb: (chatId: string) => void | Promise<void>): void { this.#events.onSessionCreated(cb); }
  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void | Promise<void>): void { this.#events.onFinished(cb); }
  onFailed(cb: (chatId: string, error: string, metadata?: TurnEventMetadata) => void | Promise<void>): void { this.#events.onFailed(cb); }
  onControl(cb: Parameters<AgentEventBus['onControl']>[0]): void { this.#events.onControl(cb); }
  onProjectionApplied(
    cb: Parameters<AgentEventBus['onProjectionApplied']>[0],
  ): void { this.#events.onProjectionApplied(cb); }
  onInputSettled(cb: Parameters<AgentEventBus['onInputSettled']>[0]): void {
    this.#events.onInputSettled(cb);
  }
  onProjectionFailure(
    cb: Parameters<AgentEventBus['onProjectionFailure']>[0],
  ): void { this.#events.onProjectionFailure(cb); }
  settleTurn(chatId: string, turn: TurnEventMetadata): void { this.#events.settleTurn(chatId, turn); }
  discardTurn(chatId: string): void { this.#events.clearTurn(chatId); }
  getActiveTurn(chatId: string): TurnEventMetadata | undefined { return this.#events.getActiveTurn(chatId); }
  projectionIngress(): AgentProjectionIngress { return this.#projection; }

  async repairProjection(
    chatId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const session = this.#registry.getChat(chatId);
    if (!session?.agentId) return false;
    const integration = this.#directory.get(session.agentId);
    if (!integration) return false;
    const chat = toAgentChatReference(
      integration,
      chatId,
      session,
      this.#getCarryOverRevision(session),
    );
    this.#projection.closeSegment(chat);
    const result = await this.#projection.open(integration, chat, signal);
    if (result.kind === 'ready') {
      await this.#persistProjectionContentEpoch(
        chatId,
        chat.agentOwnershipEpoch,
        result.value.checkpoint.projection.contentEpoch,
      );
    }
    return result.kind === 'ready';
  }

  async admitInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): Promise<{ discardKnownNotSent(): Promise<void> }> {
    const session = this.#registry.getChat(chatId);
    if (!session) throw new Error(`Session not initialized: ${chatId}`);
    const integration = this.#directory.require(session.agentId);
    const chat = toAgentChatReference(
      integration,
      chatId,
      session,
      this.#getCarryOverRevision(session),
    );
    const signal = new AbortController().signal;
    const opened = await this.#projection.open(integration, chat, signal);
    if (opened.kind !== 'ready') {
      throw new Error(opened.kind === 'deferred'
        ? 'TRANSCRIPT_PROJECTION_DEFERRED'
        : opened.errorCode);
    }
    await this.#persistProjectionContentEpoch(
      chatId,
      chat.agentOwnershipEpoch,
      opened.value.checkpoint.projection.contentEpoch,
    );
    const operation = this.#admissionIdentity(chatId, session, options);
    if (options.commandType !== 'steer') {
      this.#events.trackTurn(chatId, {
        commandType: operation.turnOwner.commandType,
        clientRequestId: operation.turnOwner.clientRequestId,
        turnId: operation.turnOwner.turnId,
        agentOwnershipEpoch: operation.agentOwnershipEpoch,
        turnOwner: operation.turnOwner,
      });
    }
    const preparation = await integration.transcript.prepareInput({
      chat,
      signal,
      message,
      operation,
    });
    let admission: AdmissionCommitResult;
    try {
      admission = await commitAdmission(integration, chat, operation, preparation, signal);
    } catch (error) {
      if (error instanceof ProjectionAdmissionAmbiguousError) {
        this.#projection.fence(chat, error);
      }
      throw error;
    }
    if (admission.kind === 'event') {
      await this.#projection.applyReturnedEvent(integration, chat, admission.event);
    } else {
      verifySettledAdmission(
        this.#projection.current(chat)?.entries ?? opened.value.entries,
        operation,
        admission,
      );
    }
    return {
      discardKnownNotSent: async () => {
        const reset = await preparation.discardCommitted();
        await this.#projection.applyReturnedEvent(integration, chat, reset);
      },
    };
  }

  #admissionIdentity(
    chatId: string,
    session: AgentChatEntry,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): AgentTranscriptAdmissionIdentity {
    if (!session.agentOwnershipEpoch) throw new Error('Agent ownership epoch is required');
    const ownership = agentOwnershipEpoch(session.agentOwnershipEpoch);
    const commandType = options.commandType
      ?? (session.agentSessionId ? 'agent-run' : 'chat-start');
    if (commandType === 'agent-compact') {
      throw new TypeError('Compaction does not admit a transcript input');
    }
    let owner: AgentTurnReceiptOwner;
    if (commandType === 'steer') {
      const active = this.#events.getActiveTurn(chatId);
      if (!active?.turnOwner) throw new Error('Cannot admit a steer without an active turn owner');
      owner = active.turnOwner;
    } else {
      if (!options.turnId) throw new TypeError('Accepted input is missing a turn ID');
      owner = {
        agentOwnershipEpoch: ownership,
        commandType,
        clientRequestId: options.clientRequestId,
        turnId: options.turnId,
      };
    }
    return {
      agentOwnershipEpoch: ownership,
      commandType,
      clientRequestId: options.clientRequestId,
      clientMessageId: options.clientMessageId ?? null,
      turnId: owner.turnId,
      turnOwner: owner,
    };
  }

  async #persistProjectionContentEpoch(
    chatId: string,
    ownershipEpoch: string,
    contentEpoch: string,
  ): Promise<void> {
    const current = this.#registry.getChat(chatId);
    if (!current || current.agentOwnershipEpoch !== ownershipEpoch) {
      throw new Error('Projection content epoch belongs to a stale owner');
    }
    if (current.transcriptContentEpoch === contentEpoch) return;
    await this.#registry.updateChat(
      chatId,
      { transcriptContentEpoch: contentEpoch },
      { flush: true },
    );
  }
  getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}) { return this.#catalog.getAgentCatalogEntry(agentId, query); }
  getAgentCatalogEntries() { return this.#catalog.getAgentCatalogEntries(); }
}

async function commitAdmission(
  integration: AgentIntegrationV4,
  chat: AgentChatReferenceV4,
  operation: AgentTranscriptAdmissionIdentity,
  preparation: AgentInputPreparation,
  signal: AbortSignal,
): Promise<AdmissionCommitResult> {
  let commitError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return { kind: 'event', event: await preparation.commit() };
    } catch (error) {
      commitError ??= error;
    }
    let resolved: Awaited<ReturnType<AgentIntegrationV4['transcript']['resolveInputAdmission']>>;
    try {
      resolved = await integration.transcript.resolveInputAdmission({ chat, signal, operation });
    } catch (error) {
      throw new ProjectionAdmissionAmbiguousError(commitError, error);
    }
    switch (resolved.kind) {
      case 'committed':
      case 'discarded':
        return { kind: 'event', event: resolved.event };
      case 'committed-settled':
      case 'discarded-settled':
        return resolved;
      case 'prepared':
        continue;
      case 'rolled-back':
      case 'absent':
        throw commitError;
      case 'degraded':
        throw new ProjectionAdmissionAmbiguousError(
          commitError,
          new Error(resolved.errorCode),
        );
    }
  }
  throw new ProjectionAdmissionAmbiguousError(
    commitError,
    new Error('Projection admission could not prove its commit outcome'),
  );
}

type AdmissionCommitResult =
  | { readonly kind: 'event'; readonly event: AgentStreamEvent }
  | { readonly kind: 'committed-settled'; readonly entryId: string }
  | { readonly kind: 'discarded-settled'; readonly entryId: string };

class ProjectionAdmissionAmbiguousError extends Error {
  constructor(commitError: unknown, resolutionError: unknown) {
    super('Projection admission outcome is ambiguous', {
      cause: new AggregateError([commitError, resolutionError]),
    });
    this.name = 'ProjectionAdmissionAmbiguousError';
  }
}

function verifySettledAdmission(
  entries: readonly import('@garcon/server-agent-interface').AgentTranscriptEntry[],
  operation: AgentTranscriptAdmissionIdentity,
  result: Exclude<AdmissionCommitResult, { readonly kind: 'event' }>,
): void {
  const entry = entries.find((candidate) => candidate.id === result.entryId);
  if (result.kind === 'discarded-settled') {
    if (entry) throw new TypeError('Discarded admission still exists in the opened projection');
    return;
  }
  if (!entry || entry.lifetime !== 'durable'
      || entry.provenance?.clientRequestId !== operation.clientRequestId
      || entry.provenance.turnOwner.turnId !== operation.turnOwner.turnId
      || entry.provenance.agentOwnershipEpoch !== operation.agentOwnershipEpoch) {
    throw new TypeError('Settled admission does not match the opened durable projection');
  }
}

import type {
  AgentGoalControlHandoff,
  AgentNativeSessionRef,
  AgentProjectPathUpdatePreparation,
  AgentSteerResult,
  AgentSteerTarget,
  AgentTranscriptSourceLocation,
  AgentTranscriptAdmissionIdentity,
  AgentProjectionState,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { CarriedContext } from '@garcon/common/transcript-seed';
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { ChatTransientControlAction } from '../../common/chat-transient-feed.js';
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
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
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
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { NativeTranscriptActivityService } from '../ledger/native-activity.js';
import { transcriptViewId, type LedgerRow } from '../ledger/contracts.js';
import type { TranscriptCommitEvent, TranscriptLedgerService } from '../ledger/service.js';
import { ledgerRowsToMessages } from '../ledger/presentation.js';
import { StaleTranscriptViewError, SubmissionConflictError } from '../ledger/errors.js';
import { DomainError } from '../lib/domain-error.js';

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
  currentTranscriptViewId(chatId: string): Promise<string>;
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
    control: ChatTransientControlAction,
  ): Promise<void>;
  prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void>;
  notifyProjectPathRelocated(chatId: string): void;
  resolveNativeSession(session: AgentChatEntry, chatId?: string): Promise<AgentNativeSessionRef | null>;
  describeTranscriptSource(
    session: AgentChatEntry,
    chatId: string,
  ): Promise<AgentTranscriptSourceLocation | null>;
  verifyProjectionEntry(
    session: AgentChatEntry | null,
    chatId: string,
    ordinal: number,
    entryId: string,
  ): Promise<boolean>;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry>;
}

// Composite page assembled from V4 projection pages for the transcript reader.
interface MutableAgentTranscriptPage {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
  revision: string;
  projectionState: AgentProjectionState | null;
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

export class AgentRegistry implements AgentRegistryServiceContract {
  readonly #registry: IChatRegistry;
  readonly #directory: AgentDirectory;
  readonly #catalog: AgentCatalogService;
  readonly #events: AgentEventBus;
  readonly #projection: AgentProjectionIngress;
  readonly #runtime: AgentRuntimeRouter;
  readonly #settings: AgentSessionSettingsService;
  readonly #getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #transcriptListeners = new Set<(
    event: TranscriptCommitEvent,
  ) => void | Promise<void>>();

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
    onCarryOverChanged?: (chatId: string) => void | Promise<void>;
    chatMutationLock?: KeyedPromiseLock;
    ledger: TranscriptLedgerService;
    adoption: TranscriptAdoptionService;
    nativeActivity?: NativeTranscriptActivityService;
  }) {
    this.#registry = args.registry;
    this.#getCarryOverRevision = args.getCarryOverRevision;
    this.#ledger = args.ledger;
    this.#adoption = args.adoption;
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
      ledger: this.#ledger,
      adoption: this.#adoption,
      nativeActivity: args.nativeActivity,
    });
    this.#settings = new AgentSessionSettingsService({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
      chatMutationLock: args.chatMutationLock,
    });
    this.#ledger.subscribe((event) => this.#onTranscriptCommit(event));
  }

  hasAgent(agentId: string): boolean { return this.#directory.has(agentId); }
  supportsAuthLogin(agentId: string): boolean { return Boolean(this.#directory.get(agentId)?.auth?.launchLogin); }
  supportsAuthLoginCompletion(agentId: string): boolean { return Boolean(this.#directory.get(agentId)?.auth?.completeLogin); }
  supportsFork(agentId: string): boolean { return this.#directory.has(agentId); }
  singleQueryRunsToolsWithoutPermission(agentId: string): boolean {
    return this.#directory.get(agentId)?.singleQuery?.runsToolsWithoutPermission ?? false;
  }
  supportsForkAtMessage(agentId: string): boolean { return this.#directory.has(agentId); }
  supportsForkWhileRunning(agentId: string): boolean { return this.#directory.has(agentId); }
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
    control: ChatTransientControlAction,
  ): Promise<void> {
    return this.#runtime.resolvePermission(chatId, permissionRequestId, decision, control);
  }
  prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<AgentProjectPathUpdatePreparation | void> {
    return this.#runtime.prepareProjectPathUpdate(agentId, request);
  }
  notifyProjectPathRelocated(chatId: string): void {
    this.#runtime.notifyProjectPathRelocated(chatId);
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

  // Returns the durable segment preview together with the ledger identity it
  // was read under so the metadata cache can be keyed by content, not chat id.
  async getPreview(session: AgentChatEntry | null, chatId = ''): Promise<{
    preview: unknown;
    contentEpoch: string | null;
    durableRevision: string | null;
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
      contentEpoch: this.#ledger.currentView(chatId)?.viewId ?? null,
      durableRevision: String(this.#ledger.highWatermark(chatId).ordinal),
    };
  }

  async loadMessages(session: AgentChatEntry | null, chatId = ''): Promise<ChatMessage[]> {
    return [...(await this.loadTranscriptSnapshot(session, chatId)).messages];
  }

  // Client-request identities already committed to the serving ledger.
  async listSettledInputRequests(
    session: AgentChatEntry | null,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly string[]> {
    signal.throwIfAborted();
    if (!session || !chatId) return [];
    await this.#adoption.ensure(chatId, signal);
    return ledgerInputRequestIds(this.#ledger.currentRows(chatId));
  }

  // Retains the legacy caller shape until pending-input settlement is removed.
  async listNativelyBoundInputRequests(
    session: AgentChatEntry | null,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly string[]> {
    return this.listSettledInputRequests(session, chatId, signal);
  }

  async loadTranscriptSnapshot(
    session: AgentChatEntry | null,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ) {
    if (!session?.agentId || !chatId) {
      return { messages: [], revision: transcriptRevision([]), projectionState: null };
    }
    await this.#adoption.ensure(chatId, signal);
    const messages = ledgerRowsToMessages(this.#ledger.currentRows(chatId));
    return {
      messages,
      revision: transcriptRevision(messages),
      projectionState: null,
    };
  }

  async loadLegacyProjectionMessages(
    session: AgentChatEntry,
    chatId: string,
    signal: AbortSignal,
  ): Promise<readonly ChatMessage[]> {
    const integration = this.#directory.get(session.agentId);
    if (!integration) return [];
    const chat = toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session));
    const opened = await this.#projection.open(integration, chat, signal);
    if (opened.kind !== 'ready') throw transcriptAccessFailure(opened);
    return opened.value.entries.map((entry) => entry.message);
  }

  // Loads the immutable rendering fold for share/export capture.
  async loadDurableTranscriptSnapshot(
    session: AgentChatEntry | null,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{
    readonly messages: readonly ChatMessage[];
    readonly projectionState: AgentProjectionState | null;
  }> {
    if (!session?.agentId || !chatId) return { messages: [], projectionState: null };
    await this.#adoption.ensure(chatId, signal);
    return {
      messages: ledgerRowsToMessages(this.#ledger.currentRows(chatId)),
      projectionState: null,
    };
  }

  // Verifies a search anchor: the current-segment entry at the given ordinal
  // must still carry the anchored identity. Non-ready reads report false so
  // navigation rejects instead of scrolling to a possibly reused ordinal.
  async verifyProjectionEntry(
    session: AgentChatEntry | null,
    chatId: string,
    ordinal: number,
    entryId: string,
  ): Promise<boolean> {
    if (!session?.agentId || !Number.isSafeInteger(ordinal) || ordinal < 1) return false;
    await this.#adoption.ensure(chatId);
    const view = this.#ledger.currentView(chatId);
    return view?.viewId === entryId && this.#ledger.currentRows(chatId).some((row) => row.ordinal === ordinal);
  }

  async loadMessagePage(
    session: AgentChatEntry | null,
    limit: number,
    offset: number,
    chatId = '',
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MutableAgentTranscriptPage | null> {
    if (!session?.agentId || !chatId) return null;
    await this.#adoption.ensure(chatId, signal);
    const view = this.#ledger.currentView(chatId);
    if (!view) return null;
    const all = ledgerRowsToMessages(this.#ledger.currentRows(chatId));
    const total = all.length;
    const end = Math.max(0, total - offset);
    const messages = all.slice(Math.max(0, end - limit), end);
    return {
      messages,
      total,
      hasMore: end - messages.length > 0,
      offset,
      limit,
      revision: transcriptRevision(all),
      projectionState: null,
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
    const nativeSessions = integration.nativeSessions;
    if (!nativeSessions) return null;
    const reference = await nativeSessions.resolveNativeSession({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session)),
      signal: new AbortController().signal,
    });
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
      const nativeSessions = integration.nativeSessions;
      if (!nativeSessions) return null;
      const source = await nativeSessions.describeSource({
        chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(session)),
        signal: new AbortController().signal,
      });
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
  onTranscriptCommitted(listener: (event: TranscriptCommitEvent) => void | Promise<void>): void {
    this.#transcriptListeners.add(listener);
  }

  async repairProjection(
    chatId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    await this.#adoption.ensure(chatId, signal);
    return true;
  }

  async currentTranscriptViewId(chatId: string): Promise<string> {
    return (await this.#adoption.ensure(chatId)).viewId;
  }

  resendCandidates(chatId: string) {
    return this.#ledger.resendCandidates(chatId);
  }

  async admitInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): Promise<{ readonly inserted: boolean }> {
    const session = this.#registry.getChat(chatId);
    if (!session) throw new Error(`Session not initialized: ${chatId}`);
    const view = await this.#adoption.ensure(chatId);
    this.#admissionIdentity(chatId, session, options);
    return this.#commitInput(chatId, message, options, view.viewId);
  }

  admitQueuedInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
  ): { readonly inserted: boolean } {
    const session = this.#registry.getChat(chatId);
    if (!session) throw new Error(`Session not initialized: ${chatId}`);
    this.#admissionIdentity(chatId, session, options);
    const view = this.#ledger.currentView(chatId);
    if (!view) throw new Error(`Transcript view is not initialized for ${chatId}`);
    return this.#commitInput(chatId, message, options, view.viewId);
  }

  #commitInput(
    chatId: string,
    message: UserMessage,
    options: PendingUserInputRegistrationOptions & { readonly clientRequestId: string },
    currentViewId: ReturnType<typeof transcriptViewId>,
  ): { readonly inserted: boolean } {
    let composition;
    try {
      composition = this.#ledger.appendInputAndCompose({
        chatId,
        viewId: options.transcriptViewId ? transcriptViewId(options.transcriptViewId) : currentViewId,
        message,
        attachments: (options.images ?? []).map((image) => ({
          kind: 'image' as const,
          data: image.data,
          name: image.name ?? null,
          mimeType: image.mimeType ?? 'application/octet-stream',
        })),
        clientMessageId: options.clientMessageId ?? null,
        steer: options.commandType === 'steer',
        ...(options.excludedResendOrdinals?.length
          ? { excludedOrdinals: new Set(options.excludedResendOrdinals) }
          : {}),
      });
    } catch (error) {
      if (error instanceof StaleTranscriptViewError) {
        throw new DomainError('STALE_TRANSCRIPT_VIEW', error.message, 409, false, { cause: error });
      }
      if (error instanceof SubmissionConflictError) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', error.message, 409, false, { cause: error });
      }
      throw error;
    }
    return { inserted: composition.inserted };
  }

  async #onTranscriptCommit(event: TranscriptCommitEvent): Promise<void> {
    for (const listener of this.#transcriptListeners) await listener(event);
    if (event.type === 'session') {
      this.#registry.updateChat(event.chatId, {
        agentSessionId: event.row.detail.agentSessionId,
        nativeSession: event.row.detail.nativeSession,
        nativeSeedReceipt: event.row.detail.nativeSeedReceipt,
      });
      await this.#events.publishSession(event.chatId);
    } else if (event.type === 'run-ended') {
      await this.#events.publishRunEnded(event.chatId, event.runId, event.row);
    }
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

  getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}) { return this.#catalog.getAgentCatalogEntry(agentId, query); }
  getAgentCatalogEntries() { return this.#catalog.getAgentCatalogEntries(); }
}

function transcriptAccessFailure(
  result:
    | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
    | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean },
): TranscriptHistoryUnavailableError {
  return new TranscriptHistoryUnavailableError(result.kind === 'deferred'
    ? { kind: 'degraded', errorCode: 'TRANSCRIPT_DEFERRED', retryable: true }
    : { kind: 'degraded', errorCode: result.errorCode, retryable: result.retryable });
}

function ledgerInputRequestIds(rows: readonly LedgerRow[]): string[] {
  return rows.flatMap((row) => (
    row.kind === 'user-input' && row.detail.message.metadata?.clientRequestId
      ? [row.detail.message.metadata.clientRequestId]
      : []
  ));
}

function messageText(message: ChatMessage): string {
  return 'content' in message && typeof message.content === 'string'
    ? message.content
    : message.type;
}

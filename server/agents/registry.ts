import type { AgentTranscriptPage, AgentTranscriptSourceLocation } from '@garcon/server-agent-interface';
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import type { ChatMessage } from '@garcon/common/chat-types';
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
import type { IntegrationRegistry } from './integration-registry.js';
import type {
  AgentChatEntry,
  AgentExecutionAdmission,
  AgentExecutionCommandType,
  AgentSessionSettingsPatch,
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

const logger = createLogger('agents:registry');

export interface AgentRegistryServiceContract {
  hasAgent(agentId: string): boolean;
  supportsAuthLogin(agentId: string): boolean;
  supportsAuthLoginCompletion(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  supportsForkAtMessage(agentId: string): boolean;
  supportsForkWhileRunning(agentId: string): boolean;
  supportsUpdateProjectPath(agentId: string): boolean;
  requiresNativePathForProjectPathUpdate(agentId: string): boolean;
  supportsImages(agentId: string): boolean;
  requiresStrictModelDiscovery(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
  submitActiveInput(chatId: string, command: string, opts: RunAgentTurnOptions, beforeDelivery: () => Promise<void>): Promise<boolean>;
  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>>;
  getRunningChatIdsSnapshot(): string[];
  startSession(chatId: string, command: string, opts?: StartSessionOptions): Promise<void>;
  forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }): Promise<StartedAgentSession | null>;
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
  resolvePermission(chatId: string, permissionRequestId: string, decision: PermissionDecisionPayload): void;
  prepareProjectPathUpdate(agentId: string, request: PrepareProjectPathUpdateRequest): Promise<void>;
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
  readonly #runtime: AgentRuntimeRouter;
  readonly #settings: AgentSessionSettingsService;
  readonly #getCarryOverRevision: (chatId: string) => string;

  constructor(args: {
    registry: IChatRegistry;
    integrations: IntegrationRegistry;
    endpointResolver: ApiProviderEndpointResolver;
    getCarryOverRevision(chatId: string): string;
    loadCarryOver(chatId: string, entry: AgentChatEntry): readonly ChatMessage[];
    chatMutationLock?: KeyedPromiseLock;
  }) {
    this.#registry = args.registry;
    this.#getCarryOverRevision = args.getCarryOverRevision;
    this.#directory = new AgentDirectory(args.integrations);
    this.#catalog = new AgentCatalogService({
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
    });
    this.#events = new AgentEventBus(this.#directory);
    this.#runtime = new AgentRuntimeRouter({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: args.endpointResolver,
      events: this.#events,
      getCarryOverRevision: args.getCarryOverRevision,
      loadCarryOver: args.loadCarryOver,
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
  supportsForkAtMessage(agentId: string): boolean { return this.#directory.get(agentId)?.forking?.supportsAtMessage ?? false; }
  supportsForkWhileRunning(agentId: string): boolean { return this.#directory.get(agentId)?.forking?.supportsWhileRunning ?? false; }
  supportsUpdateProjectPath(agentId: string): boolean { return this.#directory.get(agentId)?.descriptor.supportsProjectPathUpdate ?? false; }
  requiresNativePathForProjectPathUpdate(agentId: string): boolean {
    return this.#directory.get(agentId)?.descriptor.requiresNativePathForProjectPathUpdate ?? false;
  }
  supportsImages(agentId: string): boolean { return this.#directory.get(agentId)?.descriptor.supportsImages ?? false; }

  requiresStrictModelDiscovery(agentId: string): boolean {
    return this.#catalog.requiresStrictModelDiscovery(agentId);
  }

  startSession(chatId: string, command: string, opts: StartSessionOptions = {}): Promise<void> {
    return this.#runtime.startSession(chatId, command, opts);
  }
  runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    return this.#runtime.runAgentTurn(chatId, command, opts);
  }
  submitActiveInput(chatId: string, command: string, opts: RunAgentTurnOptions, beforeDelivery: () => Promise<void>): Promise<boolean> {
    return this.#runtime.submitActiveInput(chatId, command, opts, beforeDelivery);
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
  resolvePermission(chatId: string, permissionRequestId: string, decision: PermissionDecisionPayload): void {
    this.#runtime.resolvePermission(chatId, permissionRequestId, decision);
  }
  prepareProjectPathUpdate(agentId: string, request: PrepareProjectPathUpdateRequest): Promise<void> {
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
    return integration?.transcript.preview({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(chatId)),
      signal: new AbortController().signal,
    }) ?? null;
  }

  async loadMessages(session: AgentChatEntry | null, chatId = ''): Promise<ChatMessage[]> {
    if (!session?.agentId) return [];
    const integration = this.#directory.get(session.agentId);
    if (!integration) return [];
    return [...(await integration.transcript.load({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(chatId)),
      signal: new AbortController().signal,
    })).messages];
  }

  async loadMessagePage(
    session: AgentChatEntry | null,
    limit: number,
    offset: number,
    chatId = '',
  ): Promise<MutableAgentTranscriptPage | null> {
    if (!session?.agentId) return null;
    const integration = this.#directory.get(session.agentId);
    if (!integration?.transcript.loadPage) return null;
    const page = await integration.transcript.loadPage({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(chatId)),
      page: { limit, offset },
      signal: new AbortController().signal,
    });
    return page ? { ...page, messages: [...page.messages] } : null;
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
    const reference = await integration.transcript.resolveNativeSession({
      chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(chatId)),
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
      const source = await integration.transcript.describeSource({
        chat: toAgentChatReference(integration, chatId, session, this.#getCarryOverRevision(chatId)),
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

  onMessages(cb: (chatId: string, messages: ChatMessage[], metadata?: TurnEventMetadata) => void): void { this.#events.onMessages(cb); }
  onProcessing(cb: (chatId: string, processing: boolean) => void): void { this.#events.onProcessing(cb); }
  onSessionCreated(cb: (chatId: string) => void): void { this.#events.onSessionCreated(cb); }
  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void { this.#events.onFinished(cb); }
  onFailed(cb: (chatId: string, error: string, metadata?: TurnEventMetadata) => void): void { this.#events.onFailed(cb); }
  settleTurn(chatId: string, turn: TurnEventMetadata): void { this.#events.settleTurn(chatId, turn); }
  discardTurn(chatId: string): void { this.#events.clearTurn(chatId); }
  getActiveTurn(chatId: string): TurnEventMetadata | undefined { return this.#events.getActiveTurn(chatId); }
  getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}) { return this.#catalog.getAgentCatalogEntry(agentId, query); }
  getAgentCatalogEntries() { return this.#catalog.getAgentCatalogEntries(); }
}

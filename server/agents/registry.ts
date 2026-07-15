// Facade over focused agent services. Keep external callers stable while
// runtime routing, catalog reads, event fan-out, and settings mutation
// live behind narrower ownership boundaries.

import type { IChatRegistry } from "../chats/store.js";
import type { ChatMessage } from '../../common/chat-types.js';
import type { AgentCommandImage } from "../../common/ws-requests.js";
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type {
  AmpAgentMode,
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from "../../common/chat-modes.js";
import type {
  AgentChatEntry,
  AgentSessionSettingsPatch,
  PrepareProjectPathUpdateRequest,
  RunAgentTurnOptions,
  StartedAgentSession,
} from "./session-types.js";
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { Agent, AgentTranscriptPage } from './types.js';
import {
  isVisibleAgentId,
  type AgentCatalogEntry,
  type AgentModelOption,
} from "../../common/agents.js";
import type { ApiProtocol } from "../../common/api-providers.js";
import type { SlashCommand } from "../../common/slash-commands.js";
import type { AgentModelQuery } from './types.js';
import { AgentCatalogService } from './catalog-service.js';
import { AgentDirectory } from './directory.js';
import { AgentEventBus, type TurnEventMetadata } from './event-bus.js';
import { AgentRuntimeRouter } from './runtime-router.js';
import { AgentSessionSettingsService } from './session-settings-service.js';

export interface AgentRegistryServiceContract {
  hasAgent(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  supportsForkAtMessage(agentId: string): boolean;
  supportsForkWhileRunning(agentId: string): boolean;
  supportsUpdateProjectPath(agentId: string): boolean;
  requiresNativePathForProjectPathUpdate(agentId: string): boolean;
  supportsImages(agentId: string): boolean;
  requiresStrictModelDiscovery(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>>;
  startSession(chatId: string, command: string, opts?: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: ThinkingMode;
    claudeThinkingMode?: ClaudeThinkingMode;
    ampAgentMode?: AmpAgentMode;
    projectPath?: string;
    clientRequestId?: string;
    turnId?: string;
  }): Promise<void>;
  forkAgentSession?(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
  }): Promise<StartedAgentSession | null>;
  compactSession(chatId: string, opts?: { instructions?: string; clientRequestId?: string; turnId?: string }): Promise<void>;
  getAgentAuthStatusMap(): Promise<Record<string, unknown>>;
  getAgentReadinessMap(): Promise<Record<string, unknown>>;
  getAgentAuthStatus(agentId: string): Promise<unknown | null>;
  getAgentCatalogEntries(): Promise<AgentCatalogEntry[]>;
  getAgentCatalogEntry(agentId: string, query?: AgentModelQuery): Promise<AgentCatalogEntry | null>;
  launchAgentAuthLogin(agentId: string): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code?: string; needsCode?: boolean };
  }>;
  completeAgentAuthLogin(agentId: string, code: string): Promise<{ completed: boolean }>;
  getAgentAuthLoginStatus(agentId: string): Promise<{
    running: boolean;
    deviceAuth?: { url: string; code?: string; needsCode?: boolean };
  }>;
  modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean>;
  runSingleQuery(prompt: string, options?: { agentId?: string; [key: string]: unknown }): Promise<string>;
  getSlashCommands(agentId: string, projectPath: string): Promise<SlashCommand[]>;
  resolvePermission(chatId: string, permissionRequestId: string, decision: PermissionDecisionPayload): void;
  prepareProjectPathUpdate(agentId: string, request: PrepareProjectPathUpdateRequest): Promise<void>;
  resolveNativePath(session: AgentChatEntry): Promise<string | null>;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry>;
}

interface AgentAuthStatus {
  authenticated?: boolean;
}

function isAgentAuthStatus(value: unknown): value is AgentAuthStatus {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class AgentRegistry implements AgentRegistryServiceContract {
  #registry: IChatRegistry;
  #directory: AgentDirectory;
  #endpointResolver: ApiProviderEndpointResolver;
  #catalog: AgentCatalogService;
  #events: AgentEventBus;
  #runtime: AgentRuntimeRouter;
  #settings: AgentSessionSettingsService;

  constructor(args: {
    registry: IChatRegistry;
    agents: Agent[];
    endpointResolver: ApiProviderEndpointResolver;
  }) {
    this.#registry = args.registry;
    this.#endpointResolver = args.endpointResolver;
    this.#directory = new AgentDirectory(args.agents);
    this.#catalog = new AgentCatalogService({
      directory: this.#directory,
      endpointResolver: this.#endpointResolver,
    });
    this.#events = new AgentEventBus(this.#directory);
    this.#runtime = new AgentRuntimeRouter({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: this.#endpointResolver,
      events: this.#events,
    });
    this.#settings = new AgentSessionSettingsService({
      registry: this.#registry,
      directory: this.#directory,
      endpointResolver: this.#endpointResolver,
    });
  }

  hasAgent(agentId: string): boolean {
    return this.#directory.has(agentId);
  }

  supportsFork(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsFork ?? false;
  }

  supportsForkAtMessage(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsForkAtMessage ?? false;
  }

  supportsForkWhileRunning(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsForkWhileRunning ?? false;
  }

  supportsUpdateProjectPath(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsUpdateProjectPath ?? false;
  }

  requiresNativePathForProjectPathUpdate(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.requiresNativePathForProjectPathUpdate ?? false;
  }

  supportsImages(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.supportsImages ?? false;
  }

  requiresStrictModelDiscovery(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.requiresStrictModelDiscovery ?? false;
  }

  acceptsApiProviderEndpoints(agentId: string): boolean {
    return this.#directory.get(agentId)?.capabilities.acceptsApiProviderEndpoints ?? false;
  }

  supportedProtocols(agentId: string): ApiProtocol[] {
    return this.#directory.get(agentId)?.capabilities.supportedProtocols ?? [];
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
    turnId?: string;
  } = {}): Promise<void> {
    return this.#runtime.startSession(chatId, command, opts);
  }

  async runAgentTurn(chatId: string, command: string, opts: RunAgentTurnOptions = {}): Promise<void> {
    return this.#runtime.runAgentTurn(chatId, command, opts);
  }

  async abortSession(chatId: string): Promise<boolean> {
    return this.#runtime.abortSession(chatId);
  }

  async compactSession(chatId: string, opts: { instructions?: string; clientRequestId?: string; turnId?: string } = {}): Promise<void> {
    return this.#runtime.compactSession(chatId, opts);
  }

  isChatRunning(chatId: string): boolean {
    return this.#runtime.isChatRunning(chatId);
  }

  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean {
    return this.#runtime.isAgentSessionRunning(agentId, agentSessionId);
  }

  getRunningSessions(): Record<string, Array<{ id: string;[key: string]: unknown }>> {
    return this.#runtime.getRunningSessions();
  }

  getRunningSessionCount(): number {
    return this.#runtime.getRunningSessionCount();
  }

  resolvePermission(chatId: string, permissionRequestId: string, decision: PermissionDecisionPayload): void {
    this.#runtime.resolvePermission(chatId, permissionRequestId, decision);
  }

  async prepareProjectPathUpdate(
    agentId: string,
    request: PrepareProjectPathUpdateRequest,
  ): Promise<void> {
    await this.#runtime.prepareProjectPathUpdate(agentId, request);
  }

  async forkAgentSession(args: {
    sourceSession: AgentChatEntry;
    sourceChatId: string;
    targetChatId: string;
  }): Promise<StartedAgentSession | null> {
    return this.#runtime.forkAgentSession(args);
  }

  async updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<AgentChatEntry> {
    return this.#settings.updateSessionSettings(chatId, patch);
  }

  async runSingleQuery(prompt: string, options: { agentId?: string;[key: string]: unknown } = {}): Promise<string> {
    return this.#runtime.runSingleQuery(prompt, options);
  }

  async getSlashCommands(agentId: string, projectPath: string): Promise<SlashCommand[]> {
    return this.#runtime.discoverSlashCommands(agentId, projectPath);
  }

  async getPreview(session: AgentChatEntry | null): Promise<unknown> {
    if (!session?.agentId) return null;
    const agent = this.#directory.get(session.agentId);
    if (!agent?.transcript.getPreview) return null;
    return agent.transcript.getPreview(session);
  }

  async loadMessages(session: AgentChatEntry | null, chatId?: string): Promise<ChatMessage[]> {
    if (!session?.agentId) return [];
    const agent = this.#directory.get(session.agentId);
    if (!agent) return [];
    return agent.transcript.loadMessages(session, { chatId });
  }

  async loadMessagePage(
    session: AgentChatEntry | null,
    limit: number,
    offset: number,
    chatId?: string,
  ): Promise<AgentTranscriptPage | null> {
    if (!session?.agentId) return null;
    const agent = this.#directory.get(session.agentId);
    if (!agent?.transcript.loadMessagePage) return null;
    return agent.transcript.loadMessagePage(session, { limit, offset }, { chatId });
  }

  async getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    return this.#catalog.getModels(agentId, query);
  }

  async modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    return this.#catalog.modelSupportsImages(input);
  }

  async resolveNativePath(session: AgentChatEntry): Promise<string | null> {
    if (!session.agentSessionId) return null;
    const agent = this.#directory.get(session.agentId);
    if (!agent?.transcript.resolveNativePath) return null;
    return agent.transcript.resolveNativePath(session);
  }

  async launchAgentAuthLogin(agentId: string): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code?: string; needsCode?: boolean };
  }> {
    const agent = this.#directory.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    if (!agent.capabilities.authLoginSupported || !agent.auth.launchLogin) {
      throw new Error(`Auth login is not supported for agent: ${agentId}`);
    }
    return agent.auth.launchLogin();
  }

  async completeAgentAuthLogin(agentId: string, code: string): Promise<{ completed: boolean }> {
    const agent = this.#directory.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    if (!agent.auth.completeLogin) {
      throw new Error(`Auth login completion is not supported for agent: ${agentId}`);
    }
    return agent.auth.completeLogin(code);
  }

  async getAgentAuthLoginStatus(agentId: string): Promise<{
    running: boolean;
    deviceAuth?: { url: string; code?: string; needsCode?: boolean };
  }> {
    const agent = this.#directory.get(agentId);
    if (!agent) throw new Error(`Unsupported agent: ${agentId}`);
    if (!agent.auth.loginStatus) return { running: false };
    return agent.auth.loginStatus();
  }

  async getAgentAuthStatus(agentId: string): Promise<unknown | null> {
    const agent = this.#directory.get(agentId);
    if (!agent) return null;
    return agent.auth.getAuthStatus();
  }

  async getAgentAuthStatusMap(): Promise<Record<string, unknown>> {
    const authEntries = await Promise.all(
      this.#directory.list().map(async (agent) => [agent.id, await agent.auth.getAuthStatus()] as const),
    );
    return Object.fromEntries(authEntries);
  }

  async getAgentReadinessMap(): Promise<Record<string, {
    ready: boolean;
    nativeReady: boolean;
    endpointReady: boolean;
    reason: string;
  }>> {
    const auth = await this.getAgentAuthStatusMap();
    const result: Record<string, { ready: boolean; nativeReady: boolean; endpointReady: boolean; reason: string }> = {};
    for (const agent of this.#directory.list()) {
      const agentId = agent.id;
      if (!isVisibleAgentId(agentId)) continue;
      const endpointReady = agent.capabilities.acceptsApiProviderEndpoints
        && this.#catalog.hasEndpointModels(agentId);
      const status = auth[agentId];
      const nativeReady = isAgentAuthStatus(status) && status.authenticated === true;
      result[agentId] = {
        ready: nativeReady || endpointReady,
        nativeReady,
        endpointReady,
        reason: endpointReady
          ? 'At least one compatible API provider endpoint is configured.'
          : nativeReady
            ? 'Native agent authentication is available.'
            : 'No native authentication or compatible API provider endpoint is configured.',
      };
    }
    return result;
  }

  startPurgeTimers(): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.startPurgeTimer?.();
    }
  }

  shutdown(): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.shutdown?.();
    }
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: TurnEventMetadata) => void): void {
    this.#events.onMessages(cb);
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    this.#events.onProcessing(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#events.onSessionCreated(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    this.#events.onFinished(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    this.#events.onFailed(cb);
  }

  async getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}): Promise<AgentCatalogEntry | null> {
    return this.#catalog.getAgentCatalogEntry(agentId, query);
  }

  async getAgentCatalogEntries(): Promise<AgentCatalogEntry[]> {
    return this.#catalog.getAgentCatalogEntries();
  }
}

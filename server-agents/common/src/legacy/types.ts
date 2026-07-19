import type { ChatMessage } from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import type { AgentModelOption } from '@garcon/common/agents';
import type { SlashCommand } from '@garcon/common/slash-commands';
import type {
  AgentChatEntry,
  AgentEventMetadata,
  AgentSessionSettingsPatch,
  CodexProviderConfig,
  PrepareProjectPathUpdateRequest,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from './session-types.js';
import type {
  ApiProtocol,
  ApiProviderTemplateId,
  ModelDiscoveryKind,
  OpenAiEndpointCapabilities,
} from '@garcon/common/api-providers';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
} from '@garcon/common/agent-auth';
import type {
  SearchTranscriptLoadContext,
  SearchTranscriptLoadPlan,
} from '../search/source-types.js';

export interface StoredApiProvider {
  id: string;
  label: string;
  templateId?: ApiProviderTemplateId;
  endpoints: StoredApiProviderEndpoint[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredApiProviderEndpoint {
  id: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyLabel?: string;
  capabilities?: OpenAiEndpointCapabilities;
  defaultModel: string;
  models: AgentModelOption[];
  supportsImages: boolean;
  modelDiscovery: ModelDiscoveryKind;
  headers?: Record<string, string>;
}

export type SupportedAgentProtocol = 'anthropic-messages' | 'openai-compatible';

export interface AgentRuntime {
  // Blocking methods deliver a terminal callback before resolving. A method
  // that resolves after dispatch must keep isRunning true until its later
  // terminal callback so callers retain exact turn ownership.
  startSession(request: StartSessionRequest): Promise<StartedAgentSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  submitActiveInput?(
    request: ResumeTurnRequest,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean>;
  prepareProjectPathUpdate?(request: PrepareProjectPathUpdateRequest): Promise<void>;
  // Triggers native context compaction via the agent's own mechanism. Optional:
  // agents without a dedicated mechanism compact by running a `/compact` turn.
  compact?(request: ResumeTurnRequest): Promise<void>;
  abort(agentSessionId: string): boolean | Promise<boolean>;
  isRunning(agentSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  updateSessionSettings?(agentSessionId: string, patch: AgentSessionSettingsPatch): void | Promise<void>;
  resolvePermission?(permissionRequestId: string, decision: PermissionDecisionPayload): Promise<void> | void;
  shutdown?(): void;
  startPurgeTimer?(): void;
  onMessages(cb: (chatId: string, messages: ChatMessage[], metadata?: AgentEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string, metadata?: AgentEventMetadata) => void): void;
}

export interface AgentTranscriptSource {
  loadMessages(session: AgentChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]>;
  loadMessagePage?(
    session: AgentChatEntry,
    page: { limit: number; offset: number },
    context?: { chatId?: string },
  ): Promise<AgentTranscriptPage | null>;
  getPreview?(session: AgentChatEntry): Promise<unknown>;
  resolveNativePath?(session: AgentChatEntry): Promise<string | null>;
  resolveSearchLoadPlan(
    session: AgentChatEntry,
    context: SearchTranscriptLoadContext,
  ): Promise<SearchTranscriptLoadPlan>;
  rewriteForkTranscriptEntry?(
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ): unknown;
}

export interface ForkTranscriptEntryContext {
  sourceAgentSessionId: string;
  targetAgentSessionId: string;
}

export interface AgentTranscriptPage {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
  revision?: string;
}

export interface AgentAuth {
  getAuthStatus(): Promise<unknown>;
  launchLogin?(): Promise<AgentAuthLoginLaunchResult>;
  completeLogin?(sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult>;
  loginStatus?(expectedSessionId?: string): AgentAuthLoginStatus;
}

export interface AgentModelQuery {
  strict?: boolean;
}

export interface AgentModelDiscoveryError extends Error {
  code: 'model_discovery_unavailable';
  staleModels?: AgentModelOption[];
}

export interface AgentCapabilities {
  getModels?(query?: AgentModelQuery): Promise<AgentModelOption[]>;
  supportsFork: boolean;
  // Whether rendered messages carry enough native source metadata to support
  // forking at a specific message cutoff.
  supportsForkAtMessage: boolean;
  // Whether forking is permitted while the source session is mid-turn. Requires
  // a fork implementation that snapshots the last completed turn safely.
  supportsForkWhileRunning: boolean;
  supportsUpdateProjectPath: boolean;
  requiresNativePathForProjectPathUpdate: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: SupportedAgentProtocol[];
  authLoginSupported: boolean;
  requiresStrictModelDiscovery: boolean;
}

export interface AgentEndpointSelection {
  model: string;
  apiProviderId: string;
  modelEndpointId: string;
  modelProtocol: ApiProtocol;
  isLocal: boolean;
  apiProvider: StoredApiProvider;
  endpoint: StoredApiProviderEndpoint;
}

export interface AgentEndpointRuntimeConfig {
  envOverrides?: Record<string, string>;
  codexConfig?: CodexProviderConfig;
}

export interface ForkAgentSessionArgs {
  sourceSession: AgentChatEntry;
  sourceChatId: string;
  targetChatId: string;
  envOverrides?: StartSessionRequest['envOverrides'];
  codexConfig?: StartSessionRequest['codexConfig'];
}

export interface Agent {
  id: string;
  label: string;
  runtime: AgentRuntime;
  transcript: AgentTranscriptSource;
  auth: AgentAuth;
  capabilities: AgentCapabilities;
  prepareEndpointRuntime?(selection: AgentEndpointSelection): AgentEndpointRuntimeConfig | undefined;
  forkSession?(args: ForkAgentSessionArgs): Promise<StartedAgentSession | null>;
  runSingleQuery?(prompt: string, options?: Record<string, unknown>): Promise<string>;
  discoverSlashCommands?(projectPath: string): Promise<SlashCommand[]>;
}

import type { ChatMessage } from "../../common/chat-types.js";
import type { PermissionDecisionPayload } from '../../common/chat-command-contracts.js';
import type { AgentModelOption } from "../../common/agents.js";
import type { SlashCommand } from "../../common/slash-commands.js";
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
import type { ApiProtocol } from '../../common/api-providers.js';
import type { StoredApiProvider, StoredApiProviderEndpoint } from '../api-providers/store.js';

export type SupportedAgentProtocol = 'anthropic-messages' | 'openai-compatible';

export interface AgentRuntime {
  startSession(request: StartSessionRequest): Promise<StartedAgentSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
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
  onMessages(cb: (chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
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
}

export interface AgentTranscriptPage {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface AgentAuth {
  getAuthStatus(): Promise<unknown>;
  launchLogin?(): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code: string };
  }>;
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
  // Whether forking is permitted while the source session is mid-turn. Requires
  // a fork implementation that snapshots the last completed turn safely.
  supportsForkWhileRunning: boolean;
  supportsUpdateProjectPath: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: SupportedAgentProtocol[];
  authLoginSupported: boolean;
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

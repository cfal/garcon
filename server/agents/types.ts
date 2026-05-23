import type { ChatMessage } from "../../common/chat-types.js";
import type {
  AgentChatEntry,
  AgentEventMetadata,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from './session-types.js';

export type SupportedAgentProtocol = 'anthropic-messages' | 'openai-compatible';

export interface AgentRuntime {
  startSession(request: StartSessionRequest): Promise<StartedAgentSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(agentSessionId: string): boolean | Promise<boolean>;
  isRunning(agentSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  resolvePermission?(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> | void;
  shutdown?(): void;
  startPurgeTimer?(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export interface AgentTranscriptSource {
  loadMessages(session: AgentChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]>;
  getPreview?(session: AgentChatEntry): Promise<unknown>;
}

export interface AgentAuthDriver {
  getAuthStatus(): Promise<unknown>;
  launchLogin?(): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code: string };
  }>;
}

export interface AgentCapabilityDriver {
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: SupportedAgentProtocol[];
  authLoginSupported: boolean;
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
  auth: AgentAuthDriver;
  capabilities: AgentCapabilityDriver;
  forkSession?(args: ForkAgentSessionArgs): Promise<StartedAgentSession | null>;
  runSingleQuery?(prompt: string, options?: Record<string, unknown>): Promise<string>;
}

import type { ChatMessage } from '../../common/chat-types.js';
import type {
  ProviderChatEntry,
  ProviderEventMetadata,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedProviderSession,
} from '../providers/types.js';

export type SupportedHarnessProtocol = 'anthropic-messages' | 'openai-compatible';

export interface HarnessRuntime {
  startSession(request: StartSessionRequest): Promise<StartedProviderSession>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  isRunning(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }>;
  resolvePermission?(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> | void;
  shutdown?(): void;
  startPurgeTimer?(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[], metadata?: ProviderEventMetadata) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number, metadata?: ProviderEventMetadata) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export interface HarnessTranscriptSource {
  loadMessages(session: ProviderChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]>;
  getPreview?(session: ProviderChatEntry): Promise<unknown>;
}

export interface HarnessAuthDriver {
  getAuthStatus(): Promise<unknown>;
  launchLogin?(): Promise<{
    launched: boolean;
    alreadyRunning: boolean;
    deviceAuth?: { url: string; code: string };
  }>;
}

export interface HarnessCapabilityDriver {
  getModels?(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>>;
  supportsFork: boolean;
  supportsImages: boolean;
  acceptsApiProviderEndpoints: boolean;
  supportedProtocols: SupportedHarnessProtocol[];
  authLoginSupported: boolean;
}

export interface ForkHarnessSessionArgs {
  sourceSession: ProviderChatEntry;
  sourceChatId: string;
  targetChatId: string;
  envOverrides?: StartSessionRequest['envOverrides'];
  codexConfig?: StartSessionRequest['codexConfig'];
}

export interface Harness {
  id: string;
  label: string;
  runtime: HarnessRuntime;
  transcript: HarnessTranscriptSource;
  auth: HarnessAuthDriver;
  capabilities: HarnessCapabilityDriver;
  forkSession?(args: ForkHarnessSessionArgs): Promise<StartedProviderSession | null>;
  runSingleQuery?(prompt: string, options?: Record<string, unknown>): Promise<string>;
}

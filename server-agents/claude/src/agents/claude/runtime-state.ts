import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { ClaudeActiveTurn } from './active-turn.js';
import type { ClaudeProcessTransport } from './cli-process-transport.js';
import type { ClaudeCLIMessage, ClaudeProviderSessionState } from './cli-protocol.js';
import type { ClaudeSessionOptions } from './session-options.js';

export const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const INTERRUPT_RECEIPT_TIMEOUT_MS = 5_000;
export const INTERRUPT_COMPLETION_TIMEOUT_MS = 15_000;
export type InterruptFallbackStage = 'receipt' | 'completion';

export interface ClaudeRunningSession {
  id: string;
  chatId: string;
  initialization: Promise<void> | null;
  completeInitialization: (() => void) | null;
  lastActivityAt: number;
  providerState: ClaudeProviderSessionState;
  backgroundTaskCount: number;
  unownedProviderActivity: boolean;
  activeTurn: ClaudeActiveTurn | null;
  process: ReturnType<typeof Bun.spawn> | null;
  transport: ClaudeProcessTransport<ClaudeCLIMessage> | null;
  retirement: Promise<void> | null;
  options: ClaudeSessionOptions;
  currentPermissionMode: PermissionMode;
  currentThinkingMode: ThinkingMode;
  currentClaudeThinkingMode: ClaudeThinkingMode;
  currentModel: string;
  currentEnvOverrides?: Record<string, string>;
}

export interface PendingPermission {
  permissionRequestId: string;
  incarnation: string;
  cliRequestId: string;
  agentSessionId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  eventMetadata: RuntimeEventMetadata;
  operation: AgentRuntimeOperation | undefined;
}

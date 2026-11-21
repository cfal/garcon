import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AcpClient } from './client.js';
import type { AcpInitializeParams, AcpSessionConfigOption, AcpSessionModelState } from './protocol.js';
import type { AcpResumeRequest, AcpStartRequest } from './runtime-types.js';

// The per-agent contract the shared ACP runtime is configured with.
export type AcpAbortStrategy = 'cancel' | 'process-restart';

export interface AcpSessionConfigurationContext {
  client: AcpClient;
  sessionId: string;
  request: AcpStartRequest | AcpResumeRequest;
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
  agentDefaultModelId?: string;
}

// The session state a configuration pass changed; omitted fields keep their value.
export interface AcpSessionStatePatch {
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
}

export interface AcpAgentPolicy {
  agentId: string;
  command: string | (() => string);
  args?: string[];
  abortStrategy?: AcpAbortStrategy;
  // Modes in which the runtime answers permission requests itself; agents that
  // apply a mode natively leave the remaining requests to the user.
  autoApprovePermissionModes?: readonly PermissionMode[];
  authenticateMethodId?: string | (() => string);
  mcpServers?: unknown[];
  binaryVersion?: string;
  reconnectAllowNewSession?: boolean;
  clientCapabilities?: AcpInitializeParams['clientCapabilities'];
  configureSession?: (context: AcpSessionConfigurationContext) => Promise<AcpSessionStatePatch | void>;
  newSessionModelConfig?: boolean;
  promptModelConfig?: boolean;
  promptModeConfig?: boolean;
  buildEnv?: (request: AcpStartRequest | AcpResumeRequest) => Record<string, string | undefined>;
  buildPrompt?: (request: AcpStartRequest | AcpResumeRequest) => Array<{ type: string; text?: string; [key: string]: unknown }>;
  mapPermissionMode?: (mode: PermissionMode) => string | undefined;
  mapModel?: (model: string) => string | undefined;
  resolveNativePath?: (sessionId: string) => string | null;
}

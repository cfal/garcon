import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AcpClient } from './client.js';
import type { AcpInitializeParams, AcpSessionConfigOption, AcpSessionModelState } from './protocol.js';
import type { AcpResumeRequest, AcpStartRequest } from './runtime-types.js';
import { createArtificialNativePath } from '../chats/artificial-native-path.js';
import { buildEnvFallback, buildPromptFallback } from './runtime-helpers.js';

// The per-agent contract the shared ACP runtime is configured with.
export type AcpAbortStrategy = 'cancel' | 'process-restart';

export interface AcpSessionConfigurationContext {
  client: AcpClient;
  sessionId: string;
  request: AcpStartRequest | AcpResumeRequest;
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
  agentDefaultModelId?: string;
  // Records state an agent call just changed, so a later failure in the same
  // pass cannot leave the session believing the earlier change never happened.
  applyState(patch: AcpSessionStatePatch): void;
}

// Omitted fields keep their value.
export interface AcpSessionStatePatch {
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
}

export interface AcpAgentPolicy {
  agentId: string;
  command: string | (() => string);
  args?: string[];
  abortStrategy?: AcpAbortStrategy;
  // Agents with native accept-edits mode decide edits themselves.
  acceptsEditsOnClient?: boolean;
  authenticateMethodId?: string | (() => string);
  mcpServers?: unknown[];
  clientCapabilities?: AcpInitializeParams['clientCapabilities'];
  configureSession?: (context: AcpSessionConfigurationContext) => Promise<void>;
  newSessionModelConfig?: boolean;
  promptModelConfig?: boolean;
  promptModeConfig?: boolean;
  buildEnv?: (request: AcpStartRequest | AcpResumeRequest) => Record<string, string | undefined>;
  buildPrompt?: (request: AcpStartRequest | AcpResumeRequest) => Array<{ type: string; text?: string; [key: string]: unknown }>;
  mapPermissionMode?: (mode: PermissionMode) => string | undefined;
  mapModel?: (model: string) => string | undefined;
  resolveNativePath?: (sessionId: string) => string | null;
}

type AcpRequest = AcpStartRequest | AcpResumeRequest;

// Garcon names the agent's default as an empty model or `default`; returns the
// explicitly requested model otherwise.
export function explicitAcpModel(model: string | undefined): string | undefined {
  return !model || model === 'default' ? undefined : model;
}

function mappedModel(policy: AcpAgentPolicy, model: string): string | undefined {
  const explicit = explicitAcpModel(model);
  if (!explicit) return undefined;
  return policy.mapModel ? policy.mapModel(explicit) : explicit;
}

export function newSessionModelFor(policy: AcpAgentPolicy, request: AcpRequest): string | undefined {
  if (policy.newSessionModelConfig === false) return undefined;
  return mappedModel(policy, request.model);
}

// The session state a configuration pass reads and updates.
interface AcpConfigurableSession {
  readonly client: AcpClient;
  readonly id: string;
  configOptions?: AcpSessionConfigOption[];
  models?: AcpSessionModelState;
  readonly agentDefaultModelId?: string;
}

export async function configureSessionFor(
  policy: AcpAgentPolicy,
  session: AcpConfigurableSession,
  request: AcpRequest,
): Promise<void> {
  await policy.configureSession?.({
    client: session.client,
    sessionId: session.id,
    request,
    configOptions: session.configOptions,
    models: session.models,
    agentDefaultModelId: session.agentDefaultModelId,
    applyState(patch) {
      if (patch.configOptions) session.configOptions = patch.configOptions;
      if (patch.models) session.models = patch.models;
    },
  });
}

export type AcpPrompt = Array<{ type: string; text?: string; [key: string]: unknown }>;

export function promptFor(policy: AcpAgentPolicy, request: AcpRequest): AcpPrompt {
  const prompt = policy.buildPrompt ? policy.buildPrompt(request) : buildPromptFallback(request);
  return prompt.length > 0 ? prompt : buildPromptFallback(request);
}

export function childEnvironmentFor(policy: AcpAgentPolicy, request: AcpRequest): Record<string, string | undefined> {
  return policy.buildEnv ? policy.buildEnv(request) : buildEnvFallback(request);
}

export function promptConfigFor(policy: AcpAgentPolicy, request: AcpRequest): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const mode = policy.promptModeConfig === false ? undefined : policy.mapPermissionMode?.(request.permissionMode);
  if (mode) config.mode = mode;
  const model = policy.promptModelConfig === false ? undefined : mappedModel(policy, request.model);
  if (model) config.model = model;
  return Object.keys(config).length > 0 ? config : null;
}

export function nativePathFor(policy: AcpAgentPolicy, sessionId: string): string | null {
  return policy.resolveNativePath ? policy.resolveNativePath(sessionId) : createArtificialNativePath(policy.agentId, sessionId);
}

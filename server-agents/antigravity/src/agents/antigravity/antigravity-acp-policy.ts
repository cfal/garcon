import type { PermissionMode } from '@garcon/common/chat-modes';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type {
  AcpAgentPolicy,
  AcpSessionConfigurationContext,
} from '@garcon/server-agent-common/acp/policy';
import type { AcpResumeRequest, AcpStartRequest } from '@garcon/server-agent-common/acp/runtime-types';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';

export const ANTIGRAVITY_AGENT_ID = 'antigravity';

export type AntigravityMode = 'default' | 'accept-edits' | 'plan';

// Bypass modes keep the CLI's `default` mode; the shared runtime answers its
// permission requests instead. In `accept-edits` agy approves edits itself, so
// the requests it still sends (commands, network) go to the user.
export const ANTIGRAVITY_AUTO_APPROVE_MODES: readonly PermissionMode[] = ['manualBypass', 'bypassPermissions'];

export function antigravityModeForPermissionMode(permissionMode: PermissionMode): AntigravityMode {
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'acceptEdits') return 'accept-edits';
  return 'default';
}

export function antigravityPrompt(
  request: AcpStartRequest | AcpResumeRequest,
): Array<{ type: string; [key: string]: unknown }> {
  // An image-only message sends no empty text part, which Gemini rejects.
  const text = request.command.trim();
  if (!text && !request.images?.length) {
    throw new AgentIntegrationError('PROVIDER_FAILURE', 'Antigravity needs a message or an image to send.', false);
  }
  const prompt: Array<{ type: string; [key: string]: unknown }> = text ? [{ type: 'text', text }] : [];
  for (const attachment of request.images ?? []) {
    const parts = parseAttachmentDataUrl(attachment.data);
    const mimeType = parts?.mimeType ?? attachment.mimeType;
    if (!parts || !mimeType.startsWith('image/')) {
      throw new AgentIntegrationError(
        'PROVIDER_FAILURE',
        `Antigravity cannot attach ${attachment.name ?? 'an attachment'}: only base64 image data URLs are supported`,
        false,
      );
    }
    prompt.push({ type: 'image', mimeType, data: parts.base64 });
  }
  return prompt;
}

export async function configureAntigravitySession(
  context: AcpSessionConfigurationContext,
): Promise<void> {
  const models = await applyAntigravityModel(
    context.client,
    context.sessionId,
    context.models,
    requestedAntigravityModel(context.request.model) ?? context.agentDefaultModelId,
  );
  if (models) context.applyState({ models });

  const configOptions = await applyAntigravityMode(
    context.client,
    context.sessionId,
    context.configOptions,
    antigravityModeForPermissionMode(context.request.permissionMode),
  );
  if (configOptions) context.applyState({ configOptions });
}

// Garcon names the agent's default as an empty model or `default`.
export function requestedAntigravityModel(model: string | undefined): string | undefined {
  return !model || model === 'default' ? undefined : model;
}

// Returns the updated model state, or undefined when the session already uses
// the model or none is named. Callers pass the agent's default for an empty
// request, so choosing "default" after an explicit model switches back.
export async function applyAntigravityModel(
  client: Pick<AcpSessionConfigurationContext['client'], 'setSessionModel'>,
  sessionId: string,
  models: AcpSessionConfigurationContext['models'],
  model: string | undefined,
): Promise<AcpSessionConfigurationContext['models'] | undefined> {
  if (!model || model === models?.currentModelId) return undefined;
  const available = models?.availableModels ?? [];
  if (available.length > 0 && !available.some((entry) => entry.modelId === model)) {
    throw new AgentIntegrationError(
      'PROVIDER_FAILURE',
      `Antigravity model ${model} is not available for this account.`,
      false,
    );
  }
  await client.setSessionModel({ sessionId, modelId: model });
  return { ...models, currentModelId: model };
}

// The mode is set before every turn, even when the cached options already show
// it: the agent can change its own mode, and Garcon tracks no notification
// that would prove the session is still in the cached one. Unknown
// options (a resume that returned none) still get the mode. A session that does
// not offer a non-default mode fails rather than running in another one; single
// queries rely on `plan`.
export async function applyAntigravityMode(
  client: Pick<AcpSessionConfigurationContext['client'], 'setSessionConfigOption'>,
  sessionId: string,
  configOptions: AcpSessionConfigurationContext['configOptions'],
  mode: AntigravityMode,
): Promise<AcpSessionConfigurationContext['configOptions'] | undefined> {
  const modeOption = configOptions?.find((option) => option.id === 'mode');
  if (configOptions) {
    const offered = modeOption?.options?.some((option) => option.value === mode) ?? false;
    if (!offered) {
      if (mode === 'default' && !modeOption) return undefined;
      throw new AgentIntegrationError('PROVIDER_FAILURE', `Antigravity does not offer the ${mode} mode for this session.`, false);
    }
  }
  const result = await client.setSessionConfigOption({ sessionId, configId: 'mode', value: mode });
  return result.configOptions;
}

export function createAntigravityNativePath(agentSessionId: string): string | null {
  return createArtificialNativePath(ANTIGRAVITY_AGENT_ID, agentSessionId);
}

export function createAntigravityAcpPolicy(config: AntigravityConfig): AcpAgentPolicy {
  return {
    agentId: ANTIGRAVITY_AGENT_ID,
    command: config.binary,
    args: ['acp'],
    abortStrategy: 'cancel',
    autoApprovePermissionModes: ANTIGRAVITY_AUTO_APPROVE_MODES,
    authenticateMethodId: config.authMethod,
    clientCapabilities: {},
    newSessionModelConfig: false,
    promptModelConfig: false,
    promptModeConfig: false,
    configureSession: configureAntigravitySession,
    buildPrompt: antigravityPrompt,
    buildEnv: (request) => antigravityChildEnvironment(config, request.envOverrides),
    resolveNativePath: createAntigravityNativePath,
  };
}

import type { PermissionMode } from '@garcon/common/chat-modes';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  explicitAcpModel,
  type AcpAgentPolicy,
  type AcpSessionConfigurationContext,
} from '@garcon/server-agent-common/acp/policy';
import type { AcpResumeRequest, AcpStartRequest } from '@garcon/server-agent-common/acp/runtime-types';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';

export const ANTIGRAVITY_AGENT_ID = 'antigravity';

export type AntigravityMode = 'default' | 'accept-edits' | 'plan';

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
    explicitAcpModel(context.request.model) ?? offeredModel(context.models, context.agentDefaultModelId),
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

// A remembered default the session no longer offers, as after the account
// changed, is left alone rather than failing every Default turn.
function offeredModel(
  models: AcpSessionConfigurationContext['models'],
  model: string | undefined,
): string | undefined {
  const available = models?.availableModels;
  if (!model || available === undefined) return model;
  if (!Array.isArray(available)) return undefined;
  return available.length === 0 || available.some((entry) => entry?.modelId === model) ? model : undefined;
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
  if (Array.isArray(available) && available.length > 0 && !available.some((entry) => entry?.modelId === model)) {
    throw new AgentIntegrationError(
      'PROVIDER_FAILURE',
      `Antigravity model ${model} is not available for this account.`,
      false,
    );
  }
  await client.setSessionModel({ sessionId, modelId: model });
  return { ...models, currentModelId: model };
}

function sessionModeOption(configOptions: AcpSessionConfigurationContext['configOptions']) {
  if (configOptions == null) return undefined;
  if (!Array.isArray(configOptions) || configOptions.some((option) => typeof option?.id !== 'string')) {
    throw new AgentIntegrationError('PROVIDER_FAILURE', 'Antigravity returned invalid session config options.', false);
  }
  return configOptions.find((option) => option.id === 'mode');
}

// The agent can change its own mode, so only a fresh setter reply confirms it.
export async function applyAntigravityMode(
  client: Pick<AcpSessionConfigurationContext['client'], 'setSessionConfigOption'>,
  sessionId: string,
  configOptions: AcpSessionConfigurationContext['configOptions'],
  mode: AntigravityMode,
): Promise<AcpSessionConfigurationContext['configOptions'] | undefined> {
  if (configOptions != null) {
    const modeOption = sessionModeOption(configOptions);
    const mustBeAdvertised = modeOption !== undefined || mode !== 'default';
    const choices = modeOption?.options;
    if (mustBeAdvertised && !(Array.isArray(choices) && choices.some((option) => option?.value === mode))) {
      throw new AgentIntegrationError('PROVIDER_FAILURE', `Antigravity does not offer the ${mode} mode for this session.`, false);
    }
  }
  const result = await client.setSessionConfigOption({ sessionId, configId: 'mode', value: mode });
  const applied = sessionModeOption(result?.configOptions)?.currentValue;
  if (typeof applied !== 'string') {
    throw new AgentIntegrationError('PROVIDER_FAILURE', `Antigravity did not confirm the requested ${mode} mode.`, false);
  }
  if (applied !== mode) {
    throw new AgentIntegrationError('PROVIDER_FAILURE', `Antigravity did not apply the requested mode: expected ${mode}, got ${applied}.`, false);
  }
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
    authenticateMethodId: config.authMethod,
    clientCapabilities: {},
    configureSession: configureAntigravitySession,
    buildPrompt: antigravityPrompt,
    buildEnv: (request) => antigravityChildEnvironment(config, request.envOverrides),
    resolveNativePath: createAntigravityNativePath,
  };
}

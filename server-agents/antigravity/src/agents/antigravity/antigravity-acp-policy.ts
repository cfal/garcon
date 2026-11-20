import type { PermissionMode } from '@garcon/common/chat-modes';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type {
  AcpAgentPolicy,
  AcpSessionConfigurationContext,
  AcpSessionStatePatch,
} from '@garcon/server-agent-common/acp/agent-runtime';
import type { AcpResumeRequest, AcpStartRequest } from '@garcon/server-agent-common/acp/runtime-types';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';

export const ANTIGRAVITY_AGENT_ID = 'antigravity';

export type AntigravityMode = 'default' | 'accept-edits' | 'plan';

// Bypass modes keep the CLI's `default` mode; the shared runtime answers its
// permission requests instead.
export function antigravityModeForPermissionMode(permissionMode: PermissionMode): AntigravityMode {
  if (permissionMode === 'plan') return 'plan';
  if (permissionMode === 'acceptEdits') return 'accept-edits';
  return 'default';
}

export function antigravityPrompt(
  request: AcpStartRequest | AcpResumeRequest,
): Array<{ type: string; [key: string]: unknown }> {
  const prompt: Array<{ type: string; [key: string]: unknown }> = [
    { type: 'text', text: request.command.trim() },
  ];
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
): Promise<AcpSessionStatePatch> {
  const patch: AcpSessionStatePatch = {};
  const model = context.request.model;
  if (model && model !== context.models?.currentModelId) {
    const available = context.models?.availableModels ?? [];
    if (available.length > 0 && !available.some((entry) => entry.modelId === model)) {
      throw new AgentIntegrationError(
        'PROVIDER_FAILURE',
        `Antigravity model ${model} is not available for this account.`,
        false,
      );
    }
    await context.client.setSessionModel({ sessionId: context.sessionId, modelId: model });
    patch.models = { ...context.models, currentModelId: model };
  }

  const mode = antigravityModeForPermissionMode(context.request.permissionMode);
  const modeOption = context.configOptions?.find((option) => option.id === 'mode');
  if (modeOption && modeOption.currentValue !== mode) {
    const result = await context.client.setSessionConfigOption({
      sessionId: context.sessionId,
      configId: modeOption.id,
      value: mode,
    });
    if (result.configOptions) patch.configOptions = result.configOptions;
  }
  return patch;
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
    newSessionModelConfig: false,
    promptModelConfig: false,
    promptModeConfig: false,
    configureSession: configureAntigravitySession,
    buildPrompt: antigravityPrompt,
    buildEnv: (request) => antigravityChildEnvironment(request.envOverrides),
    resolveNativePath: createAntigravityNativePath,
  };
}

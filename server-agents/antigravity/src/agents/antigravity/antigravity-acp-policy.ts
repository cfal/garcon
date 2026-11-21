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

  const configOptions = await applyAntigravityMode(
    context.client,
    context.sessionId,
    context.configOptions,
    antigravityModeForPermissionMode(context.request.permissionMode),
  );
  if (configOptions) patch.configOptions = configOptions;
  return patch;
}

// Unknown options (a resume that returned none) still get the mode, since a
// skipped mode would run the turn in whatever mode the session last had.
export async function applyAntigravityMode(
  client: Pick<AcpSessionConfigurationContext['client'], 'setSessionConfigOption'>,
  sessionId: string,
  configOptions: AcpSessionConfigurationContext['configOptions'],
  mode: AntigravityMode,
): Promise<AcpSessionConfigurationContext['configOptions'] | undefined> {
  const modeOption = configOptions?.find((option) => option.id === 'mode');
  if (configOptions && !modeOption) return undefined;
  if (modeOption?.currentValue === mode) return undefined;
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
    buildEnv: (request) => antigravityChildEnvironment(request.envOverrides),
    resolveNativePath: createAntigravityNativePath,
  };
}

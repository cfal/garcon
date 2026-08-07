import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import { CommandValidationError } from '../lib/command-validation-error.js';

type AttachmentAgentCapabilities = Pick<
  AgentRegistryServiceContract,
  'modelSupportsImages' | 'supportsImages' | 'supportsFileAttachmentMimeType'
>;

export interface AttachmentSupportInput {
  agentId: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  attachments: NonNullable<RunAgentTurnOptions['images']>;
}

export async function assertAttachmentsSupported(
  agents: AttachmentAgentCapabilities,
  input: AttachmentSupportInput,
): Promise<void> {
  if (input.attachments.length === 0) return;
  const mimeTypes = input.attachments.map((attachment) => {
    const mimeType = attachment.mimeType?.trim().toLowerCase();
    if (!mimeType) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'Attachment MIME type is required',
        400,
      );
    }
    return mimeType;
  });

  if (mimeTypes.some((mimeType) => mimeType.startsWith('image/'))) {
    let modelSupportsImages = false;
    try {
      modelSupportsImages = await agents.modelSupportsImages({
        agentId: input.agentId,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
      });
    } catch {}
    const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
    const supportsImages = hasBackendSelection
      ? modelSupportsImages
      : agents.supportsImages(input.agentId);
    if (!supportsImages) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Attachments unsupported for agent: ${input.agentId}`,
        422,
      );
    }
  }

  for (const mimeType of mimeTypes) {
    if (mimeType.startsWith('image/')) continue;
    if (!agents.supportsFileAttachmentMimeType(input.agentId, mimeType)) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `${mimeType} attachments unsupported for agent: ${input.agentId}`,
        422,
      );
    }
  }
}

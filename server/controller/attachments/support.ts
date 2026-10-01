import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import { CommandValidationError } from '../lib/command-validation-error.js';

export type AttachmentAgentCapabilities = Pick<
  AgentRegistryServiceContract,
  'assertExecutorReady' | 'modelSupportsImages' | 'supportsImages' | 'supportsFileAttachmentMimeType'
>;

type Attachments = NonNullable<RunAgentTurnOptions['images']>;

export interface AttachmentSupportInput {
  executorId?: string | null;
  agentId: string;
  model?: string | null;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  attachments: Readonly<Attachments>;
}

// Synchronous so queued dequeue can revalidate inside its admission block,
// where the chat's selection may have changed since the entry was queued.
export function assertAttachmentsSupported(
  agents: AttachmentAgentCapabilities,
  input: AttachmentSupportInput,
): void {
  if (input.attachments.length === 0) return;
  if (!input.model) {
    throw new CommandValidationError(
      'INCOMPLETE_EXECUTION_CONFIG',
      'The chat has no model to receive attachments',
      422,
    );
  }
  agents.assertExecutorReady(input.executorId);
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
      modelSupportsImages = agents.modelSupportsImages({
        executorId: input.executorId,
        agentId: input.agentId,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
      });
    } catch {}
    const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
    const supportsImages = hasBackendSelection
      ? modelSupportsImages
      : agents.supportsImages(input.agentId, input.executorId);
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
    if (!agents.supportsFileAttachmentMimeType(input.agentId, mimeType, input.executorId)) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `${mimeType} attachments unsupported for agent: ${input.agentId}`,
        422,
      );
    }
  }
}

import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import { CommandValidationError } from '../lib/command-validation-error.js';
import { isImageAttachmentMimeType } from '../../../common/attachments.js';

export type AttachmentAgentCapabilities = Pick<
  AgentRegistryServiceContract,
  'assertExecutorReady' | 'modelSupportsImages' | 'supportsImages' | 'fileAttachmentAdmission'
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

  if (mimeTypes.some(isImageAttachmentMimeType)) {
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

  input.attachments.forEach((attachment, index) => {
    const mimeType = mimeTypes[index];
    if (isImageAttachmentMimeType(mimeType)) return;
    const admission = agents.fileAttachmentAdmission(
      input.agentId,
      { mimeType, sizeBytes: attachmentSizeBytes(attachment.data) },
      input.executorId,
    );
    if (admission.kind === 'unsupported-type') {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `${mimeType} attachments unsupported for agent: ${input.agentId}`,
        422,
      );
    }
    if (admission.kind === 'text-too-large') {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `${attachment.name ?? mimeType} is too large for agent ${input.agentId} to read; the limit for text attachments is ${Math.floor(admission.maxBytes / 1000)} KB`,
        422,
      );
    }
  });
}

function attachmentSizeBytes(data: string): number {
  const base64 = data.slice(data.indexOf(',') + 1);
  return Buffer.byteLength(base64, 'base64');
}

import type { AgentAttachment } from '@garcon/common/agent-execution';

export function parseOpenCodeModel(
  model: string | undefined,
): { providerID: string; modelID: string } | null {
  if (!model || typeof model !== 'string') return null;
  const separator = model.indexOf('/');
  if (separator < 1 || separator === model.length - 1) return null;
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export const GARCON_OPERATION_PART_METADATA_KEY = 'garcon_operation_part_id';

// OpenCode compares monotonic user and assistant IDs when deciding whether a turn is complete.
// Letting OpenCode assign both IDs preserves that ordering. Image attachments ride as file
// parts with data URLs, the same shape OpenCode's own app submits; the provider assigns their
// part IDs, so the operation identity stays on the text prompt part alone.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/prompt.ts#L1111-L1116
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/app/src/components/prompt-input/build-request-parts.ts#L197-L203
export function buildPromptBody(
  command: string,
  model: string | undefined,
  partId: string,
  attachments: readonly AgentAttachment[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [
      {
        id: partId,
        type: 'text',
        text: command,
        metadata: { [GARCON_OPERATION_PART_METADATA_KEY]: partId },
      },
      ...attachments
        .filter((attachment) => attachment.kind === 'image')
        .map((attachment) => ({
          type: 'file',
          mime: attachment.mimeType,
          url: attachment.data,
          ...(attachment.name ? { filename: attachment.name } : {}),
        })),
    ],
  };
  const parsedModel = parseOpenCodeModel(model);
  if (parsedModel) body.model = parsedModel;
  return body;
}

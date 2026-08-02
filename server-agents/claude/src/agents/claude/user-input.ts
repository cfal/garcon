import type { AgentAttachment } from '@garcon/common/agent-execution';
import {
  appendTextAttachmentContext,
  attachmentDocumentBlock,
  documentAttachments,
  imageAttachments,
  parseAttachmentDataUrl,
} from '@garcon/server-agent-common/shared/attachments';

export interface ClaudeUserInputFrameOptions {
  readonly content: unknown;
  readonly sessionId: string;
  readonly uuid: string;
}

export function buildClaudeUserInputFrame(options: ClaudeUserInputFrameOptions): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: options.content },
    parent_tool_use_id: null,
    session_id: options.sessionId,
    uuid: options.uuid,
  });
}

export function buildClaudeInitialUserContent(
  command: string,
  attachments?: readonly AgentAttachment[],
): unknown {
  const prompt = appendTextAttachmentContext(command, attachments);
  const images = imageAttachments(attachments);
  const documents = documentAttachments(attachments);
  if (images.length === 0 && documents.length === 0) return prompt;

  const blocks: unknown[] = [];
  for (const image of images) {
    const parts = parseAttachmentDataUrl(image.data);
    if (parts) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parts.mimeType, data: parts.base64 },
      });
    }
  }
  for (const document of documents) {
    const block = attachmentDocumentBlock(document);
    if (block) blocks.push(block);
  }
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

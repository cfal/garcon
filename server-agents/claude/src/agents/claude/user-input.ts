import crypto from 'node:crypto';
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
  readonly priority?: 'next';
}

export const CLAUDE_STEERING_PROMPT_PREFIX =
  'The user sent steering guidance for the active task:\n\n';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeNativeInputUuid(clientMessageId?: string): string {
  return clientMessageId && UUID_PATTERN.test(clientMessageId)
    ? clientMessageId
    : crypto.randomUUID();
}

export function buildClaudeUserInputFrame(options: ClaudeUserInputFrameOptions): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: options.content },
    parent_tool_use_id: null,
    session_id: options.sessionId,
    uuid: options.uuid,
    ...(options.priority ? { priority: options.priority } : {}),
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

export function buildClaudeSteeringUserContent(input: string): readonly [{
  readonly type: 'text';
  readonly text: string;
}] {
  return [{
    type: 'text',
    text: `${CLAUDE_STEERING_PROMPT_PREFIX}${input}`,
  }];
}

export function claudeSteeringInputsFromNativeContent(
  content: unknown,
): readonly string[] | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  const inputs: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
    if (!('type' in block) || block.type !== 'text') return null;
    if (!('text' in block) || typeof block.text !== 'string') return null;
    if (!block.text.startsWith(CLAUDE_STEERING_PROMPT_PREFIX)) return null;
    inputs.push(block.text.slice(CLAUDE_STEERING_PROMPT_PREFIX.length));
  }
  return inputs;
}

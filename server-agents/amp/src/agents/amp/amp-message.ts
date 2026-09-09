import { AssistantMessage, ThinkingMessage, ToolResultMessage, type ChatMessage } from '@garcon/common/chat-types';
import { normalizeToolResultContent } from '@garcon/server-agent-common/shared/normalize-util';
import { convertAmpToolUse, isAmpHousekeepingToolUse } from './tool-use-converter.js';

// Represents a JSONL message emitted by the Amp CLI on stdout.
export interface AmpCliMessage {
  type: string;
  subtype?: string;
  thread_id?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string;
  content?: AmpCliContentPart[];
  message?: {
    content?: AmpCliContentPart[];
    stop_reason?: string | null;
  };
}

interface AmpCliContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

// Extracts the content array from an Amp CLI assistant message,
// handling both top-level and nested `.message.content` shapes.
export function getAssistantContent(msg: AmpCliMessage): AmpCliContentPart[] {
  if (Array.isArray(msg.content)) return msg.content;
  if (Array.isArray(msg.message?.content)) return msg.message!.content!;
  return [];
}

export function getUserText(msg: AmpCliMessage): string {
  return getAssistantContent(msg)
    .filter((part): part is AmpCliContentPart & { text: string } => (
      part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
}

export function convertAmpMessageToChatMessages(
  msg: AmpCliMessage,
  hiddenToolUseIds: Set<string>,
): ChatMessage[] {
  if (msg.type !== 'assistant') return [];

  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const content = getAssistantContent(msg);

  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (part.type === 'tool_use') {
      if (isAmpHousekeepingToolUse(part)) {
        if (part.id) hiddenToolUseIds.add(part.id);
        continue;
      }
      chatMessages.push(convertAmpToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      if (part.tool_use_id && hiddenToolUseIds.delete(part.tool_use_id)) continue;
      chatMessages.push(new ToolResultMessage(now, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
    }
  }

  return chatMessages;
}

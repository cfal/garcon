import { parseChatId, type ChatId } from './chat-id.js';
import {
  AssistantMessage,
  UserMessage,
  type ChatMessage,
} from './chat-types.js';

export const CHAT_ID_DISCOVERY_REQUEST_MARKER = '<get-garcon-chat-id />';
export const CHAT_ID_DISCLOSURE_OPEN = '\n\n<garcon-chat-id>';
export const CHAT_ID_DISCLOSURE_CLOSE = '</garcon-chat-id>';
export const CHAT_ID_REQUEST_NOTICE_TITLE = 'Request: Garcon Chat ID';
export const CHAT_ID_REQUEST_NOTICE_CONTENT = 'Agent requested chat ID';
export const CHAT_ID_DISCLOSURE_NOTICE_TITLE = 'Response: Garcon Chat ID';

export type ChatIdDisclosureDelivery = 'input' | 'steer';

export interface ChatIdRequestTransform {
  readonly message: AssistantMessage | null;
}

export function transformChatIdRequest(
  message: ChatMessage,
): ChatIdRequestTransform | null {
  if (
    message.type !== 'assistant-message'
    || !message.content.startsWith(CHAT_ID_DISCOVERY_REQUEST_MARKER)
  ) {
    return null;
  }

  const content = message.content.slice(CHAT_ID_DISCOVERY_REQUEST_MARKER.length);
  return {
    message: content ? new AssistantMessage(message.timestamp, content) : null,
  };
}

export function appendChatIdDisclosure(content: string, chatId: ChatId): string {
  return `${content}${CHAT_ID_DISCLOSURE_OPEN}${chatId}${CHAT_ID_DISCLOSURE_CLOSE}`;
}

export function stripImportedChatIdDisclosure(content: string): string {
  if (!content.endsWith(CHAT_ID_DISCLOSURE_CLOSE)) return content;
  const open = content.lastIndexOf(CHAT_ID_DISCLOSURE_OPEN);
  if (open < 0) return content;

  const valueStart = open + CHAT_ID_DISCLOSURE_OPEN.length;
  const valueEnd = content.length - CHAT_ID_DISCLOSURE_CLOSE.length;
  try {
    parseChatId(content.slice(valueStart, valueEnd));
  } catch {
    return content;
  }
  return content.slice(0, open);
}

export function sanitizeImportedChatIdMessage(
  message: ChatMessage,
): ChatMessage | null {
  const request = transformChatIdRequest(message);
  if (request) return request.message;
  if (message.type !== 'user-message') return message;

  const content = stripImportedChatIdDisclosure(message.content);
  return content === message.content
    ? message
    : new UserMessage(
      message.timestamp,
      content,
      message.images,
      message.metadata,
      message.presentation,
    );
}

export function chatIdDisclosureNoticeContent(
  chatId: ChatId,
  delivery: ChatIdDisclosureDelivery,
): string {
  return delivery === 'steer'
    ? `Sent chat ID ${chatId} to agent (steer)`
    : `Sent chat ID ${chatId} to agent`;
}

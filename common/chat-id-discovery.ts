import { parseChatId, type ChatId } from './chat-id.js';
import {
  AssistantMessage,
  type ChatMessage,
} from './chat-types.js';
import type { ChatIdDiscoveryFailureReason } from './transcript-notice-details.js';

export const CHAT_ID_DISCOVERY_REQUEST_MARKER = '<get-garcon-chat-id />';
export const CHAT_ID_DISCLOSURE_OPEN = '<garcon-chat-id>';
export const CHAT_ID_DISCLOSURE_CLOSE = '</garcon-chat-id>';
export const CHAT_ID_DISCOVERY_NOTICE_TITLE = 'Chat ID auto-discovery';

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

  const content = message.content
    .slice(CHAT_ID_DISCOVERY_REQUEST_MARKER.length)
    .trimStart();
  return {
    message: content ? new AssistantMessage(message.timestamp, content) : null,
  };
}

export function chatIdDisclosureContent(chatId: ChatId): string {
  return `${CHAT_ID_DISCLOSURE_OPEN}${chatId}${CHAT_ID_DISCLOSURE_CLOSE}`;
}

export function parseChatIdDisclosure(content: string): ChatId | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(CHAT_ID_DISCLOSURE_OPEN)
      || !trimmed.endsWith(CHAT_ID_DISCLOSURE_CLOSE)) return null;
  const value = trimmed.slice(
    CHAT_ID_DISCLOSURE_OPEN.length,
    -CHAT_ID_DISCLOSURE_CLOSE.length,
  );
  try {
    return parseChatId(value);
  } catch {
    return null;
  }
}

export function chatIdDisclosureNoticeContent(chatId: ChatId): string {
  return `Sent chat ID ${chatId} to agent.`;
}

export function chatIdDiscoveryFailureContent(reason: ChatIdDiscoveryFailureReason): string {
  switch (reason) {
    case 'disabled':
      return 'Chat ID auto-discovery is disabled.';
    case 'unsupported':
      return 'This agent does not support chat ID auto-discovery.';
    case 'delivery-failed':
      return 'Garcon could not send the chat ID to the agent.';
  }
}

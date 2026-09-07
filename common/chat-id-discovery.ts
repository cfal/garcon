import { parseChatId, type ChatId } from './chat-id.js';
import type { ChatIdDiscoveryFailureReason } from './transcript-notice-details.js';

export const CHAT_ID_DISCLOSURE_OPEN = '<garcon-chat-id>';
export const CHAT_ID_DISCLOSURE_CLOSE = '</garcon-chat-id>';
export const CHAT_ID_DISCOVERY_NOTICE_TITLE = 'Chat ID auto-discovery';

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
    case 'delivery-failed':
      return 'Garcon could not send the chat ID to the agent.';
  }
}

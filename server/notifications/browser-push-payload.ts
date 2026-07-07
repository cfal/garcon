import type { BrowserNotificationPreviewMode } from '../../common/settings.js';
import type { AttentionNotification } from './attention-events.js';
import { truncateNotificationText } from './attention-events.js';

export const GARCON_WEB_PUSH_PAYLOAD_VERSION = 8030;

export interface BrowserPushPayload {
  web_push: typeof GARCON_WEB_PUSH_PAYLOAD_VERSION;
  notification: {
    title: string;
    body: string;
    navigate: string;
    tag: string;
    silent: boolean;
    app_badge?: string;
    data: {
      chatId: string;
      attentionId: string;
      reason: AttentionNotification['reason'];
      url: string;
    };
  };
}

function reasonStatus(reason: AttentionNotification['reason']): string {
  switch (reason) {
    case 'permission-required':
      return 'Needs your permission';
    case 'failed':
      return 'Chat failed';
    case 'stopped':
      return 'Chat stopped';
    case 'completed':
    default:
      return 'Chat completed';
  }
}

function notificationBody(
  event: AttentionNotification,
  previewMode: BrowserNotificationPreviewMode,
): string {
  if (event.status) return truncateNotificationText(event.status, 160);
  if (previewMode === 'message-preview' && event.assistantMessage) {
    return truncateNotificationText(event.assistantMessage, 180);
  }
  if (previewMode === 'message-preview' && event.userMessage) {
    return truncateNotificationText(event.userMessage, 180);
  }
  return reasonStatus(event.reason);
}

export function buildBrowserPushPayload({
  event,
  origin,
  previewMode,
  badgeCount,
}: {
  event: AttentionNotification;
  origin: string;
  previewMode: BrowserNotificationPreviewMode;
  badgeCount?: number | null;
}): BrowserPushPayload {
  const navigate = new URL(`/chat/${encodeURIComponent(event.chatId)}`, origin).toString();
  const notification: BrowserPushPayload['notification'] = {
    title: event.title || 'Garcon',
    body: notificationBody(event, previewMode),
    navigate,
    tag: `garcon-chat-${event.chatId}`,
    silent: false,
    data: {
      chatId: event.chatId,
      attentionId: event.id,
      reason: event.reason,
      url: navigate,
    },
  };
  if (typeof badgeCount === 'number' && Number.isFinite(badgeCount) && badgeCount >= 0) {
    notification.app_badge = String(Math.floor(badgeCount));
  }
  return {
    web_push: GARCON_WEB_PUSH_PAYLOAD_VERSION,
    notification,
  };
}

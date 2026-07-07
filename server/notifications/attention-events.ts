import type { ToolUseChatMessage } from '../../common/chat-types.js';

export type AttentionReason =
  | 'permission-required'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AttentionChatMeta {
  title: string;
  hasGeneratedTitle: boolean;
  agentId: string;
  projectPath: string;
}

export interface AttentionNotification {
  id: string;
  chatId: string;
  reason: AttentionReason;
  title: string;
  body: string;
  status: string | null;
  userMessage: string | null;
  assistantMessage: string | null;
  requestedTool?: ToolUseChatMessage;
  createdAt: string;
  meta: AttentionChatMeta;
}

export interface AttentionSink {
  notify(event: AttentionNotification): Promise<void>;
}

export function truncateNotificationText(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

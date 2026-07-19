import { AssistantMessage, type ChatMessage } from '@garcon/common/chat-types';

const THINK_CLOSE_TAG = '</think>';

export function isFactorySystemReminderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<system-reminder') && trimmed.endsWith('</system-reminder>');
}

export function visibleFactoryAssistantText(text: string): string {
  const thinkCloseIndex = text.indexOf(THINK_CLOSE_TAG);
  const visible = thinkCloseIndex >= 0
    ? text.slice(thinkCloseIndex + THINK_CLOSE_TAG.length)
    : text;
  return visible.trim();
}

export function convertFactoryAssistantText(timestamp: string, text: string): ChatMessage[] {
  const visible = visibleFactoryAssistantText(text);
  return visible ? [new AssistantMessage(timestamp, visible)] : [];
}

import { parseChatId } from '../../../../../common/chat-id.ts';
import { parseChatMessage } from '../../../../../common/chat-types.ts';

export function nullableChatId(value: unknown): boolean {
  if (value === null) return true;
  try {
    parseChatId(value);
    return true;
  } catch {
    return false;
  }
}

export function chatMessage(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  const message = parseChatMessage(input);
  return message !== null
    && (message.type !== 'assistant-message' || Boolean(input.questions) === Boolean(message.questions));
}

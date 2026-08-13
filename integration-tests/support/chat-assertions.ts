import type { ChatMessage, UserMessage } from '../../common/chat-types.js';
import type { TranscriptMessage } from '../../common/chat-view.js';

export function messagesOfType<TType extends ChatMessage['type']>(
  messages: readonly TranscriptMessage[],
  type: TType,
): Array<Extract<ChatMessage, { type: TType }>> {
  return messages
    .map((entry) => entry.message)
    .filter((message): message is Extract<ChatMessage, { type: TType }> => message.type === type);
}

export function userMessages(messages: readonly TranscriptMessage[]): UserMessage[] {
  return messagesOfType(messages, 'user-message');
}

export function userContents(messages: readonly TranscriptMessage[]): string[] {
  return userMessages(messages).map((message) => message.content);
}

export function assistantContents(messages: readonly TranscriptMessage[]): string[] {
  return messagesOfType(messages, 'assistant-message').map((message) => message.content);
}

export function countUserContent(messages: readonly TranscriptMessage[], content: string): number {
  return userMessages(messages).filter((message) => message.content === content).length;
}


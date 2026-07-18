import type { ChatMessage, UserMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';

export function messagesOfType<TType extends ChatMessage['type']>(
  messages: readonly ChatViewMessage[],
  type: TType,
): Array<Extract<ChatMessage, { type: TType }>> {
  return messages
    .map((entry) => entry.message)
    .filter((message): message is Extract<ChatMessage, { type: TType }> => message.type === type);
}

export function userMessages(messages: readonly ChatViewMessage[]): UserMessage[] {
  return messagesOfType(messages, 'user-message');
}

export function userContents(messages: readonly ChatViewMessage[]): string[] {
  return userMessages(messages).map((message) => message.content);
}

export function assistantContents(messages: readonly ChatViewMessage[]): string[] {
  return messagesOfType(messages, 'assistant-message').map((message) => message.content);
}

export function countUserContent(messages: readonly ChatViewMessage[], content: string): number {
  return userMessages(messages).filter((message) => message.content === content).length;
}


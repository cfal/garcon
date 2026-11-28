import { parseChatMessage, parseChatMessages } from "../../../../common/chat-types.ts";

export function parseChatMessageJson(value: unknown): string {
  return JSON.stringify(parseChatMessage(value));
}

export function parseChatMessagesJson(value: unknown): string {
  return JSON.stringify(parseChatMessages(value));
}

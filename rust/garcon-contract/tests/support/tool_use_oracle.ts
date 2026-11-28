import { parseChatMessage as originalParse } from "../../../../common/chat-types.ts";

export { codexSubagentSourceFingerprint, isToolUseMessage } from "../../../../common/chat-types.ts";

export function parseChatMessage(value: unknown): string {
  return JSON.stringify(originalParse(value));
}

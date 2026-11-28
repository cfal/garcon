import { parseAddChatRowRequest } from '../../../../common/chat-row-contracts.js';

export function parseChatRowJson(text: string) {
  return parseAddChatRowRequest(JSON.parse(text));
}

// `/handoff` continues a chat under the same agent in a new chat. Kept beside the
// other command contracts rather than inside them so `chat-command-contracts.ts`
// stays within its line budget.
import type { ForkRunCommandRequest } from './chat-command-contracts.js';
import { parseForkRunCommandRequest } from './chat-command-contracts.js';

// Carries no model or mode overrides. The full settings envelope is the command's
// immutable snapshot for target creation and the continuation's first turn.
export type SelfHandoffRunCommandRequest = Pick<
  ForkRunCommandRequest,
  | 'clientRequestId'
  | 'clientMessageId'
  | 'sourceChatId'
  | 'chatId'
  | 'command'
  | 'images'
  | 'agentSettings'
>;

// Reuses the fork parser for the shared fields, then drops the overrides a
// continuation has no use for rather than validating them a second time.
export function parseSelfHandoffRunCommandRequest(value: unknown): SelfHandoffRunCommandRequest {
  const parsed = parseForkRunCommandRequest(value);
  return {
    clientRequestId: parsed.clientRequestId,
    clientMessageId: parsed.clientMessageId,
    sourceChatId: parsed.sourceChatId,
    chatId: parsed.chatId,
    command: parsed.command,
    agentSettings: parsed.agentSettings,
    ...(parsed.images === undefined ? {} : { images: parsed.images }),
  };
}

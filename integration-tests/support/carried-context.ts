import {
  AssistantMessage,
  UserMessage,
} from '../../common/chat-types.js';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
} from '../../common/transcript-seed.js';

const USER_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const ASSISTANT_TIMESTAMP = '2026-01-01T00:00:00.001Z';

export function expectedCarriedInput(
  conversation: readonly string[],
  prompt: string,
): string {
  if (conversation.length === 0 || conversation.length % 2 !== 0) {
    throw new Error('Expected a non-empty alternating user/assistant conversation.');
  }
  const messages = conversation.map((content, index) => index % 2 === 0
    ? new UserMessage(USER_TIMESTAMP, content)
    : new AssistantMessage(ASSISTANT_TIMESTAMP, content));
  const context = createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS);
  if (!context) throw new Error('Expected carried context for a non-empty conversation.');
  return `${context.prefix}${prompt}`;
}

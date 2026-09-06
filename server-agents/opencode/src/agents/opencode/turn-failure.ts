import { ErrorMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import type { OpenCodeAssistantTerminal } from './sse-events.js';
import type { OpenCodeTurnContext } from './turn-events.js';

// Early cancellation can poison later prompts without a new user Stop.
// https://github.com/anomalyco/opencode/issues/30144
export const OPEN_CODE_ABORTED_TURN_FAILURE_MESSAGE = 'OpenCode interrupted the turn';

export function latestOpenCodePromptTerminal(
  turn: OpenCodeTurnContext,
): OpenCodeAssistantTerminal | undefined {
  return Array.from(turn.assistantTerminals.values())
    .filter((terminal) => !turn.automaticCompactionMessageIds.has(terminal.messageId))
    .at(-1);
}

export function openCodeProviderFailureRow(
  message: string,
  entryId: string | undefined,
  turn: OpenCodeTurnContext,
): ErrorMessage {
  const row = new ErrorMessage(new Date().toISOString(), message);
  const sourceEntryId = entryId ?? Array.from(turn.assistantMessageIds)
    .filter((candidate) => !turn.automaticCompactionMessageIds.has(candidate))
    .at(-1);
  // Terminal failures use their exact assistant; control failures retain the last observed
  // non-compaction assistant as a stable native occurrence.
  return sourceEntryId ? attachNativeMessageSource(row, { entryId: sourceEntryId }) : row;
}

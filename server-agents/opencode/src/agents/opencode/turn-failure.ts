import { ErrorMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';

// Early cancellation can poison later prompts without a new user Stop.
// https://github.com/anomalyco/opencode/issues/30144
export const OPEN_CODE_ABORTED_TURN_FAILURE_MESSAGE = 'OpenCode interrupted the turn';

export function openCodeProviderFailureRow(
  message: string,
  entryId: string | undefined,
  fallbackEntryIds: Iterable<string>,
): ErrorMessage {
  const row = new ErrorMessage(new Date().toISOString(), message);
  const sourceEntryId = entryId ?? Array.from(fallbackEntryIds).at(-1);
  // Terminal failures use their exact assistant; control failures retain the last observed
  // assistant as the stable native occurrence used before this helper was extracted.
  return sourceEntryId ? attachNativeMessageSource(row, { entryId: sourceEntryId }) : row;
}

import { ErrorMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import type { OpenCodeTurnContext } from './turn-events.js';

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

export function openCodeAbortedTurnFailureMessage(turn: OpenCodeTurnContext): string {
  // Early cancellation can poison later prompts without a new user Stop.
  // https://github.com/anomalyco/opencode/issues/30144
  if (turn.providerAbortIntent === 'user-stop') {
    return 'OpenCode interrupted the current turn without confirming the requested stop';
  }
  if (turn.providerAbortIntent === 'quiescence') {
    return 'OpenCode interrupted the previous turn while preparing the next message';
  }
  return 'OpenCode interrupted the current turn unexpectedly';
}

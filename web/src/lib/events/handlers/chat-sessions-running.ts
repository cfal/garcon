// Handles the chat-sessions-running broadcast, reconciling the processing state
// of all known chats via the session store's bulk reconciliation method.

import type { ChatSessionsRunningMessage } from '$shared/ws-events';

export interface RunningChatsContext {
  reconcileProcessing: (runningChatIds: Set<string>) => void;
}

/** Extracts the flat set of running chat IDs from a provider-grouped
 *  chat-sessions-running payload. Exported for testing. */
export function extractRunningChatIds(msg: ChatSessionsRunningMessage): Set<string> {
  const groupedSessions: unknown[] = msg.sessions && typeof msg.sessions === 'object'
    ? Object.values(msg.sessions)
    : [];
  return new Set(
    groupedSessions
      .filter((sessions): sessions is Array<{ id?: string }> => Array.isArray(sessions))
      .flatMap((sessions) => sessions)
      .map((session) => session?.id)
      .filter((id): id is string => Boolean(id)),
  );
}

export function handleRunningChats(
  msg: ChatSessionsRunningMessage,
  ctx: RunningChatsContext,
) {
  const runningChatIds = extractRunningChatIds(msg);
  ctx.reconcileProcessing(runningChatIds);
}

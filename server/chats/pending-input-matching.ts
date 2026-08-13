import type { UserMessage } from '../../common/chat-types.js';
import type { PendingUserInputRecord } from './pending-user-input-store.js';

export function matchingRequestIds(
  records: PendingUserInputRecord[],
  messages: UserMessage[],
): Set<string> {
  const matchedMessageIndexes = new Set<number>();
  const requestIds = new Set<string>();

  for (const record of records) {
    const messageIndex = messages.findIndex(
      (message, index) => (
        !matchedMessageIndexes.has(index)
        && message.metadata?.clientRequestId === record.clientRequestId
      ),
    );
    if (messageIndex < 0) continue;
    matchedMessageIndexes.add(messageIndex);
    requestIds.add(record.clientRequestId);
  }

  for (const record of records) {
    if (requestIds.has(record.clientRequestId) || !record.clientMessageId) continue;
    const messageIndex = messages.findIndex(
      (message, index) => (
        !matchedMessageIndexes.has(index)
        && message.metadata?.upstreamRequestId === record.clientMessageId
      ),
    );
    if (messageIndex < 0) continue;
    matchedMessageIndexes.add(messageIndex);
    requestIds.add(record.clientRequestId);
  }

  return requestIds;
}

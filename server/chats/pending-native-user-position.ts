import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { MutableChatView } from './chat-view-native-reconciliation.js';
import type { PendingNativeUserPosition } from './chat-view-contracts.js';
import { nativeMessageSourceKey } from './native-user-identity-registry.js';

export function pendingNativeUserPositionForAppend(
  view: MutableChatView,
  messages: readonly ChatMessage[],
): PendingNativeUserPosition | undefined {
  if (messages.length !== 1 || !(messages[0] instanceof UserMessage)) return undefined;

  const previousNativeUser = view.messages.findLast((entry) => (
    entry.seq > view.archivedLogicalCount
    && entry.seq <= view.historyLastSeq
    && entry.message instanceof UserMessage
  ));
  const previousNativeUserSourceKey = previousNativeUser
    ? nativeMessageSourceKey(previousNativeUser.message)
    : null;
  if (previousNativeUser && !previousNativeUserSourceKey) return undefined;

  const liveUserCount = view.messages.filter((entry) => (
    entry.seq > view.historyLastSeq
    && entry.message instanceof UserMessage
    && entry.message.metadata?.deliveryStatus !== 'failed'
    && entry.message.metadata?.deliveryStatus !== 'unconfirmed'
  )).length;
  return { previousNativeUserSourceKey, userOffset: liveUserCount + 1 };
}

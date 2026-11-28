import { compareChatOrderNewestFirst as compare, type ChatOrderSortKey, type ChatOrderTimestamps } from "../../../../common/chat-order-sort.ts";

export { chatActivityTimeMs, chatCreationTimeMs, isChatOrderSortKey } from "../../../../common/chat-order-sort.ts";

export function compareChatOrderNewestFirst(sortKey: ChatOrderSortKey, left: ChatOrderTimestamps, right: ChatOrderTimestamps): number {
  return compare(sortKey)(left, right);
}

import type { ChatViewMessage } from '../../common/chat-view.js';
import { exactMessageIdentityKeys } from './chat-message-reconciliation.js';
import type { MutableChatView } from './chat-view-native-reconciliation.js';

export function transferPublishedLiveEntries(
  previous: MutableChatView | undefined,
  view: MutableChatView,
): void {
  if (!previous) return;
  const published = previous.messages.filter((entry) => (
    previous.publishedLiveEntries.has(entry)
  ));
  if (previous.generationId === view.generationId) {
    const publishedSeqs = new Set(published.map((entry) => entry.seq));
    for (const entry of view.messages) {
      if (publishedSeqs.has(entry.seq)) view.publishedLiveEntries.add(entry);
    }
    return;
  }

  const publishedByIdentity = indexByExactIdentity(published);
  const retainedByIdentity = indexByExactIdentity(view.messages);
  for (const [identity, priorEntries] of publishedByIdentity) {
    const retainedEntries = retainedByIdentity.get(identity);
    if (priorEntries.length === 1 && retainedEntries?.length === 1) {
      view.publishedLiveEntries.add(retainedEntries[0]);
    }
  }
}

function indexByExactIdentity(
  entries: ChatViewMessage[],
): Map<string, ChatViewMessage[]> {
  const byIdentity = new Map<string, ChatViewMessage[]>();
  for (const entry of entries) {
    for (const identity of exactMessageIdentityKeys(entry.message)) {
      const matches = byIdentity.get(identity);
      if (matches) matches.push(entry);
      else byIdentity.set(identity, [entry]);
    }
  }
  return byIdentity;
}

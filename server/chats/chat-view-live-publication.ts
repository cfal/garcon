import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';
import { getNativeMessageRevisionSource } from '../agents/shared/native-message-source.js';
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

  const unmatchedPublished = new Set(published);
  const unmatchedRetained = new Set(view.messages);
  transferUniqueMatches(unmatchedPublished, unmatchedRetained, view, nativeSourceKey);
  transferUniqueMatches(unmatchedPublished, unmatchedRetained, view, clientRequestKey, (
    prior,
    retained,
  ) => !nativeSourcesConflict(prior.message, retained.message));
}

function transferUniqueMatches(
  published: Set<ChatViewMessage>,
  retained: Set<ChatViewMessage>,
  view: MutableChatView,
  keyFor: (message: ChatMessage) => string | null,
  canTransfer: (published: ChatViewMessage, retained: ChatViewMessage) => boolean = () => true,
): void {
  const publishedByIdentity = indexByIdentity(published, keyFor);
  const retainedByIdentity = indexByIdentity(retained, keyFor);
  for (const [identity, priorEntries] of publishedByIdentity) {
    const retainedEntries = retainedByIdentity.get(identity);
    if (priorEntries.length !== 1 || retainedEntries?.length !== 1) continue;
    const priorEntry = priorEntries[0];
    const retainedEntry = retainedEntries[0];
    if (!canTransfer(priorEntry, retainedEntry)) continue;
    view.publishedLiveEntries.add(retainedEntry);
    published.delete(priorEntry);
    retained.delete(retainedEntry);
  }
}

function indexByIdentity(
  entries: Set<ChatViewMessage>,
  keyFor: (message: ChatMessage) => string | null,
): Map<string, ChatViewMessage[]> {
  const byIdentity = new Map<string, ChatViewMessage[]>();
  for (const entry of entries) {
    const identity = keyFor(entry.message);
    if (!identity) continue;
    const matches = byIdentity.get(identity);
    if (matches) matches.push(entry);
    else byIdentity.set(identity, [entry]);
  }
  return byIdentity;
}

function nativeSourceKey(message: ChatMessage): string | null {
  const source = getNativeMessageRevisionSource(message);
  return source?.entryId && source.withinSourceOrdinal !== undefined
    ? JSON.stringify([source.entryId, source.withinSourceOrdinal])
    : null;
}

function clientRequestKey(message: ChatMessage): string | null {
  return message instanceof UserMessage
    ? message.metadata?.clientRequestId ?? null
    : null;
}

function nativeSourcesConflict(left: ChatMessage, right: ChatMessage): boolean {
  const leftSource = nativeSourceKey(left);
  const rightSource = nativeSourceKey(right);
  return Boolean(leftSource && rightSource && leftSource !== rightSource);
}

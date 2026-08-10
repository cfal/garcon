import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.js';

export function exactMessageIdentityKeys(message: ChatMessage): string[] {
  const identities: string[] = [];
  const source = getNativeMessageRevisionSource(message);
  if (source?.entryId && source.withinSourceOrdinal !== undefined) {
    identities.push(JSON.stringify(['native-source', source.entryId, source.withinSourceOrdinal]));
  }
  if (message instanceof UserMessage && message.metadata?.clientRequestId) {
    identities.push(JSON.stringify(['client-request', message.metadata.clientRequestId]));
  }
  if (message instanceof UserMessage && message.metadata?.upstreamRequestId) {
    identities.push(JSON.stringify(['upstream-request', message.metadata.upstreamRequestId]));
  }
  return identities;
}

export function preserveRetainedUserIdentities(
  retainedMessages: ChatViewMessage[],
  nativeMessages: ChatMessage[],
): ChatMessage[] {
  const nativeIndexByIdentity = new Map<string, number>();
  nativeMessages.forEach((message, index) => {
    for (const identity of exactMessageIdentityKeys(message)) {
      if (!nativeIndexByIdentity.has(identity)) nativeIndexByIdentity.set(identity, index);
    }
  });
  let reconciled = nativeMessages;
  for (const entry of retainedMessages) {
    const nativeIndex = exactMessageIdentityKeys(entry.message)
      .map((identity) => nativeIndexByIdentity.get(identity))
      .find((index) => (
        index !== undefined
        && messagesShareExactIdentity(entry.message, nativeMessages[index])
      ));
    if (nativeIndex === undefined) continue;
    const nativeMessage = nativeMessages[nativeIndex];
    const withIdentity = preserveLiveUserIdentity(entry.message, nativeMessage);
    if (withIdentity === nativeMessage) continue;
    if (reconciled === nativeMessages) reconciled = [...nativeMessages];
    reconciled[nativeIndex] = withIdentity;
  }
  return reconciled;
}

export function matchingRetainedMessagesByExactIdentity(
  retainedMessages: ChatViewMessage[],
  messages: ChatMessage[],
): ChatViewMessage[] {
  const retainedByIdentity = new Map<string, ChatViewMessage>();
  for (const entry of retainedMessages) {
    for (const identity of exactMessageIdentityKeys(entry.message)) {
      if (!retainedByIdentity.has(identity)) retainedByIdentity.set(identity, entry);
    }
  }
  const matches = new Map<number, ChatViewMessage>();
  for (const message of messages) {
    const match = exactMessageIdentityKeys(message)
      .map((identity) => retainedByIdentity.get(identity))
      .find((entry) => (
        entry !== undefined
        && messagesShareExactIdentity(entry.message, message)
      ));
    if (match) matches.set(match.seq, match);
  }
  return [...matches.values()];
}

export function reconcileLiveMessageAppends(
  retainedMessages: ChatViewMessage[],
  messages: ChatMessage[],
  conflictPolicy: 'reject' | 'native-wins',
): { messages: ChatMessage[]; droppedConflictingUserIdentities: string[] } {
  type IndexedMessage = {
    message: ChatMessage;
    retainedEntry?: ChatViewMessage;
    uniqueIndex?: number;
  };
  const existingByIdentity = new Map<string, IndexedMessage>();
  const indexMessage = (indexed: IndexedMessage): void => {
    for (const identity of exactMessageIdentityKeys(indexed.message)) {
      if (!existingByIdentity.has(identity)) existingByIdentity.set(identity, indexed);
    }
  };
  for (const entry of retainedMessages) {
    indexMessage({ message: entry.message, retainedEntry: entry });
  }

  const unique: ChatMessage[] = [];
  const droppedConflictingUserIdentities: string[] = [];
  for (const message of messages) {
    const identities = exactMessageIdentityKeys(message);
    const existing = identities
      .map((identity) => existingByIdentity.get(identity))
      .find((indexed) => (
        indexed !== undefined
        && messagesShareExactIdentity(indexed.message, message)
      ));
    if (existing) {
      if (
        existing.message instanceof UserMessage
        && message instanceof UserMessage
        && !userDeliveryPayloadsAreCompatible(existing.message, message)
      ) {
        const identity = message.metadata?.clientRequestId
          ?? message.metadata?.upstreamRequestId
          ?? identities[0]
          ?? 'unknown';
        if (conflictPolicy === 'native-wins') {
          droppedConflictingUserIdentities.push(identity);
          continue;
        }
        throw new Error(`Conflicting user message identity: ${identity}`);
      }
      const withIdentity = preserveLiveUserIdentity(message, existing.message);
      if (withIdentity !== existing.message) {
        existing.message = withIdentity;
        if (existing.retainedEntry) existing.retainedEntry.message = withIdentity;
        if (existing.uniqueIndex !== undefined) unique[existing.uniqueIndex] = withIdentity;
        indexMessage(existing);
      }
      continue;
    }
    const indexed = { message, uniqueIndex: unique.length };
    unique.push(message);
    indexMessage(indexed);
  }
  return { messages: unique, droppedConflictingUserIdentities };
}

export function retainedMessageMatchesNative(
  retainedMessage: ChatMessage,
  nativeMessage: ChatMessage | undefined,
): boolean {
  return wireMessagesEqual(retainedMessage, nativeMessage)
    || nativeMessage !== undefined
      && messagesShareExactIdentity(retainedMessage, nativeMessage);
}

export function userDeliveryPayloadsAreCompatible(
  left: UserMessage,
  right: UserMessage,
): boolean {
  return wireMessagesEqual(
    withoutMetadata(left, right.timestamp),
    withoutMetadata(right, right.timestamp),
  ) && metadataIsCompatible(left.metadata, right.metadata);
}

function preserveLiveUserIdentity(
  liveMessage: ChatMessage,
  nativeMessage: ChatMessage,
): ChatMessage {
  if (
    !(liveMessage instanceof UserMessage)
    || !(nativeMessage instanceof UserMessage)
    || !liveMessage.metadata?.clientRequestId
    || !messagesShareExactIdentity(liveMessage, nativeMessage)
  ) {
    return nativeMessage;
  }
  return attachNativeMessageSource(new UserMessage(
    nativeMessage.timestamp,
    nativeMessage.content,
    nativeMessage.images,
    { ...nativeMessage.metadata, ...liveMessage.metadata },
  ), getNativeMessageRevisionSource(nativeMessage));
}

function messagesShareExactIdentity(left: ChatMessage, right: ChatMessage): boolean {
  const leftSource = getNativeMessageRevisionSource(left);
  const rightSource = getNativeMessageRevisionSource(right);
  if (
    leftSource?.entryId
    && rightSource?.entryId === leftSource.entryId
    && leftSource.withinSourceOrdinal !== undefined
    && rightSource.withinSourceOrdinal === leftSource.withinSourceOrdinal
  ) return true;
  if (!(left instanceof UserMessage) || !(right instanceof UserMessage)) return false;
  const leftClientRequestId = left.metadata?.clientRequestId;
  const rightClientRequestId = right.metadata?.clientRequestId;
  if (leftClientRequestId && rightClientRequestId) {
    return leftClientRequestId === rightClientRequestId;
  }
  return Boolean(
    left.metadata?.upstreamRequestId
    && left.metadata.upstreamRequestId === right.metadata?.upstreamRequestId,
  );
}

function wireMessagesEqual(left: ChatMessage, right: ChatMessage | undefined): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function withoutMetadata(message: UserMessage, timestamp: string): UserMessage {
  return new UserMessage(timestamp, message.content, message.images);
}

function metadataIsCompatible(
  leftMetadata: UserMessage['metadata'],
  rightMetadata: UserMessage['metadata'],
): boolean {
  const left = leftMetadata as Record<string, unknown> | undefined;
  for (const [key, rightValue] of Object.entries(rightMetadata ?? {})) {
    const leftValue = left?.[key];
    if (leftValue !== undefined && leftValue !== rightValue) return false;
  }
  return true;
}

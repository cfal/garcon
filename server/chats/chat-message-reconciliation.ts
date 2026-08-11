import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.js';

interface MessageCandidate<T> {
  message: ChatMessage;
  readonly value: T;
}

export function exactMessageIdentityKeys(message: ChatMessage): string[] {
  const identities: string[] = [];
  const source = getNativeMessageRevisionSource(message);
  if (source?.entryId && source.withinSourceOrdinal !== undefined) {
    identities.push(JSON.stringify(['native-source', source.entryId, source.withinSourceOrdinal]));
  }
  if (message instanceof UserMessage && message.metadata?.clientRequestId) {
    identities.push(JSON.stringify(['client-request', message.metadata.clientRequestId]));
  }
  return identities;
}

export function preserveRetainedUserIdentities(
  retainedMessages: ChatViewMessage[],
  nativeMessages: ChatMessage[],
): ChatMessage[] {
  const retainedCandidates = retainedMessages.map((entry) => ({
    message: entry.message,
    value: entry,
  }));
  const nativeCandidates = nativeMessages.map((message, index) => ({ message, value: index }));
  const matches = pairUserDeliveries(retainedCandidates, nativeCandidates);
  let reconciled = nativeMessages;

  for (const [retained, native] of matches) {
    const nativeMessage = native.message;
    const withIdentity = mergeRetainedUserIdentity(retained.message, nativeMessage);
    if (withIdentity === nativeMessage) continue;
    if (reconciled === nativeMessages) reconciled = [...nativeMessages];
    reconciled[native.value] = withIdentity;
  }
  return reconciled;
}

export function matchingRetainedMessagesByDeliveryIdentity(
  retainedMessages: ChatViewMessage[],
  messages: ChatMessage[],
): ChatViewMessage[] {
  const retainedCandidates = retainedMessages.map((entry) => ({
    message: entry.message,
    value: entry,
  }));
  const incomingCandidates = messages.map((message, index) => ({ message, value: index }));
  const pairedUsers = new Map<number, ChatViewMessage>();
  for (const [incoming, retained] of pairUserDeliveries(incomingCandidates, retainedCandidates)) {
    pairedUsers.set(incoming.value, retained.value);
  }

  const retainedIndex = new ExactMessageCandidateIndex(retainedCandidates);
  const matches = new Map<number, ChatViewMessage>();
  messages.forEach((message, index) => {
    const match = message instanceof UserMessage
      ? pairedUsers.get(index)
      : retainedIndex.find(message)?.value;
    if (match) matches.set(match.seq, match);
  });
  return [...matches.values()];
}

export function reconcileLiveMessageAppends(
  retainedMessages: ChatViewMessage[],
  messages: ChatMessage[],
  conflictPolicy: 'reject' | 'native-wins',
): { messages: ChatMessage[]; droppedConflictingUserIdentities: string[] } {
  type IndexedMessage = MessageCandidate<number> & {
    readonly retainedEntry?: ChatViewMessage;
    readonly originalRetainedMessage?: ChatMessage;
    readonly uniqueIndex?: number;
  };
  const currentCandidate = (candidate: IndexedMessage): MessageCandidate<IndexedMessage> => ({
    get message() {
      return candidate.message;
    },
    value: candidate,
  });

  const retainedCandidates: IndexedMessage[] = retainedMessages.map((entry, index) => ({
    message: entry.message,
    value: index,
    retainedEntry: entry,
    originalRetainedMessage: entry.message,
  }));
  const incomingCandidates = messages.map((message, index) => ({ message, value: index }));
  const pairedUsers = new Map<number, IndexedMessage>();
  for (const [incoming, retained] of pairUserDeliveries(incomingCandidates, retainedCandidates)) {
    pairedUsers.set(incoming.value, retained);
  }

  const retainedIndex = new ExactMessageCandidateIndex<IndexedMessage>();
  for (const candidate of retainedCandidates) {
    retainedIndex.add(currentCandidate(candidate));
  }
  const acceptedIncoming = new ExactMessageCandidateIndex<IndexedMessage>();

  const unique: ChatMessage[] = [];
  const droppedConflictingUserIdentities: string[] = [];
  messages.forEach((message, messageIndex) => {
    const indexed = pairedUsers.get(messageIndex)
      ?? (message instanceof UserMessage
        ? acceptedIncoming.find(message)?.value
        : retainedIndex.find(message)?.value ?? acceptedIncoming.find(message)?.value);
    if (indexed) {
      if (
        indexed.message instanceof UserMessage
        && message instanceof UserMessage
        && !userDeliveryPayloadsAreCompatible(indexed.message, message)
      ) {
        const identity = message.metadata?.clientRequestId
          ?? message.metadata?.upstreamRequestId
          ?? exactMessageIdentityKeys(message)[0]
          ?? 'unknown';
        if (conflictPolicy === 'native-wins') {
          droppedConflictingUserIdentities.push(identity);
          return;
        }
        throw new Error(`Conflicting user message identity: ${identity}`);
      }

      const withIdentity = mergeRetainedUserIdentity(message, indexed.message);
      if (withIdentity !== indexed.message) {
        indexed.message = withIdentity;
        if (indexed.uniqueIndex !== undefined) unique[indexed.uniqueIndex] = withIdentity;
      }
      acceptedIncoming.add(currentCandidate(indexed));
      return;
    }

    const appended: IndexedMessage = {
      message,
      value: retainedCandidates.length + unique.length,
      uniqueIndex: unique.length,
    };
    unique.push(message);
    acceptedIncoming.add(currentCandidate(appended));
  });

  for (const candidate of retainedCandidates) {
    if (
      candidate.retainedEntry
      && candidate.originalRetainedMessage !== candidate.message
    ) {
      candidate.retainedEntry.message = candidate.message;
    }
  }
  return { messages: unique, droppedConflictingUserIdentities };
}

export function retainedMessageMatchesNative(
  retainedMessage: ChatMessage,
  nativeMessage: ChatMessage | undefined,
): boolean {
  if (nativeMessage === undefined || nativeMessageSourcesConflict(retainedMessage, nativeMessage)) {
    return false;
  }
  return wireMessagesEqual(retainedMessage, nativeMessage)
    || messagesShareStrongIdentity(retainedMessage, nativeMessage)
    || userMessagesCanBridgeByUpstream(retainedMessage, nativeMessage);
}

export function userDeliveryPayloadsAreCompatible(
  left: UserMessage,
  right: UserMessage,
): boolean {
  return userPayloadKey(left) === userPayloadKey(right)
    && metadataIsCompatible(left.metadata, right.metadata);
}

class ExactMessageCandidateIndex<T> {
  readonly #strong = new Map<string, Array<MessageCandidate<T>>>();

  constructor(candidates: Array<MessageCandidate<T>> = []) {
    for (const candidate of candidates) this.add(candidate);
  }

  add(candidate: MessageCandidate<T>): void {
    for (const identity of exactMessageIdentityKeys(candidate.message)) {
      appendMapValue(this.#strong, identity, candidate);
    }
  }

  find(message: ChatMessage): MessageCandidate<T> | undefined {
    const strongMatches = uniqueCandidates(
      exactMessageIdentityKeys(message)
        .flatMap((identity) => this.#strong.get(identity) ?? [])
        .filter((candidate) => messagesShareStrongIdentity(candidate.message, message)),
    );
    return strongMatches[0];
  }
}

function pairUserDeliveries<L, R>(
  leftCandidates: Array<MessageCandidate<L>>,
  rightCandidates: Array<MessageCandidate<R>>,
): Map<MessageCandidate<L>, MessageCandidate<R>> {
  const leftUsers = leftCandidates.filter(isUserCandidate);
  const rightUsers = rightCandidates.filter(isUserCandidate);
  const matches = new Map<MessageCandidate<L>, MessageCandidate<R>>();
  const matchedRight = new Set<MessageCandidate<R>>();
  const rightByStrongIdentity = new Map<string, Array<MessageCandidate<R>>>();
  for (const right of rightUsers) {
    for (const identity of exactMessageIdentityKeys(right.message)) {
      appendMapValue(rightByStrongIdentity, identity, right);
    }
  }

  for (const left of leftUsers) {
    const match = uniqueCandidates(
      exactMessageIdentityKeys(left.message)
        .flatMap((identity) => rightByStrongIdentity.get(identity) ?? [])
        .filter((right) => (
          !matchedRight.has(right)
          && messagesShareStrongIdentity(left.message, right.message)
        )),
    )[0];
    if (!match) continue;
    matches.set(left, match);
    matchedRight.add(match);
  }

  const unmatchedLeftByUpstream = new Map<string, Array<MessageCandidate<L>>>();
  const unmatchedRightByUpstream = new Map<string, Array<MessageCandidate<R>>>();
  for (const left of leftUsers) {
    if (matches.has(left)) continue;
    const key = userUpstreamPayloadKey(left.message);
    if (key) appendMapValue(unmatchedLeftByUpstream, key, left);
  }
  for (const right of rightUsers) {
    if (matchedRight.has(right)) continue;
    const key = userUpstreamPayloadKey(right.message);
    if (key) appendMapValue(unmatchedRightByUpstream, key, right);
  }

  for (const [key, leftGroup] of unmatchedLeftByUpstream) {
    const rightGroup = unmatchedRightByUpstream.get(key) ?? [];
    if (leftGroup.length === rightGroup.length && leftGroup.length > 0) {
      const orderedPairs = leftGroup.map((left, index) => [left, rightGroup[index]] as const);
      if (orderedPairs.every(([left, right]) => (
        userMessagesCanBridgeByUpstream(left.message, right.message)
      ))) {
        for (const [left, right] of orderedPairs) {
          matches.set(left, right);
          matchedRight.add(right);
        }
      }
      continue;
    }

    if (leftGroup.length !== 1 && rightGroup.length !== 1) continue;
    const compatiblePairs = leftGroup.flatMap((left) => rightGroup
      .filter((right) => userMessagesCanBridgeByUpstream(left.message, right.message))
      .map((right) => [left, right] as const));
    if (compatiblePairs.length !== 1) continue;
    const [left, right] = compatiblePairs[0];
    matches.set(left, right);
    matchedRight.add(right);
  }

  return matches;
}

function mergeRetainedUserIdentity(
  retainedMessage: ChatMessage,
  nativeMessage: ChatMessage,
): ChatMessage {
  if (
    !(retainedMessage instanceof UserMessage)
    || !(nativeMessage instanceof UserMessage)
    || !retainedMessage.metadata?.clientRequestId
  ) {
    return nativeMessage;
  }
  const metadata = { ...nativeMessage.metadata, ...retainedMessage.metadata };
  if (JSON.stringify(metadata) === JSON.stringify(nativeMessage.metadata)) return nativeMessage;
  return attachNativeMessageSource(new UserMessage(
    nativeMessage.timestamp,
    nativeMessage.content,
    nativeMessage.images,
    metadata,
  ), getNativeMessageRevisionSource(nativeMessage));
}

function messagesShareStrongIdentity(left: ChatMessage, right: ChatMessage): boolean {
  const leftSource = canonicalNativeMessageSource(left);
  const rightSource = canonicalNativeMessageSource(right);
  if (
    leftSource
    && rightSource?.entryId === leftSource.entryId
    && rightSource.withinSourceOrdinal === leftSource.withinSourceOrdinal
  ) return true;
  if (!(left instanceof UserMessage) || !(right instanceof UserMessage)) return false;
  const leftClientRequestId = left.metadata?.clientRequestId;
  const rightClientRequestId = right.metadata?.clientRequestId;
  return Boolean(
    leftClientRequestId
    && rightClientRequestId
    && leftClientRequestId === rightClientRequestId,
  );
}

function userMessagesCanBridgeByUpstream(left: ChatMessage, right: ChatMessage): boolean {
  if (!(left instanceof UserMessage) || !(right instanceof UserMessage)) return false;
  if (nativeMessageSourcesConflict(left, right)) return false;
  const leftUpstreamRequestId = left.metadata?.upstreamRequestId;
  const rightUpstreamRequestId = right.metadata?.upstreamRequestId;
  if (!leftUpstreamRequestId || leftUpstreamRequestId !== rightUpstreamRequestId) return false;
  const leftClientRequestId = left.metadata?.clientRequestId;
  const rightClientRequestId = right.metadata?.clientRequestId;
  if (
    leftClientRequestId
    && rightClientRequestId
    && leftClientRequestId !== rightClientRequestId
  ) return false;
  return userDeliveryPayloadsAreCompatible(left, right);
}

function canonicalNativeMessageSource(message: ChatMessage): {
  entryId: string;
  withinSourceOrdinal: number;
} | null {
  const source = getNativeMessageRevisionSource(message);
  return source?.entryId && source.withinSourceOrdinal !== undefined
    ? { entryId: source.entryId, withinSourceOrdinal: source.withinSourceOrdinal }
    : null;
}

function nativeMessageSourcesConflict(left: ChatMessage, right: ChatMessage): boolean {
  const leftSource = canonicalNativeMessageSource(left);
  const rightSource = canonicalNativeMessageSource(right);
  return Boolean(
    leftSource
    && rightSource
    && (
      leftSource.entryId !== rightSource.entryId
      || leftSource.withinSourceOrdinal !== rightSource.withinSourceOrdinal
    ),
  );
}

function userUpstreamPayloadKey(message: ChatMessage): string | null {
  if (!(message instanceof UserMessage) || !message.metadata?.upstreamRequestId) return null;
  return JSON.stringify([
    message.metadata.upstreamRequestId,
    userPayloadKey(message),
  ]);
}

function userPayloadKey(message: UserMessage): string {
  return JSON.stringify([message.content, message.images ?? null]);
}

function isUserCandidate<T>(candidate: MessageCandidate<T>): candidate is MessageCandidate<T> & {
  message: UserMessage;
} {
  return candidate.message instanceof UserMessage;
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function uniqueCandidates<T>(candidates: Array<MessageCandidate<T>>): Array<MessageCandidate<T>> {
  const seen = new Set<T>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}

function wireMessagesEqual(left: ChatMessage, right: ChatMessage | undefined): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
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

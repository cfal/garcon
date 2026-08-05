import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.js';

export function exactMessageIdentityKeys(message: ChatMessage): string[] {
  const identities: string[] = [];
  if (message instanceof UserMessage && message.metadata?.upstreamRequestId) {
    identities.push(JSON.stringify(['upstream-request', message.metadata.upstreamRequestId]));
  }
  if (message instanceof UserMessage && message.metadata?.clientRequestId) {
    identities.push(JSON.stringify(['client-request', message.metadata.clientRequestId]));
  }
  const source = getNativeMessageRevisionSource(message);
  if (source?.entryId && source.withinSourceOrdinal !== undefined) {
    identities.push(JSON.stringify(['native-source', source.entryId, source.withinSourceOrdinal]));
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
      .find((index) => index !== undefined);
    if (nativeIndex === undefined) continue;
    const nativeMessage = nativeMessages[nativeIndex];
    const withIdentity = preserveLiveUserIdentity(entry.message, nativeMessage);
    if (withIdentity === nativeMessage) continue;
    if (reconciled === nativeMessages) reconciled = [...nativeMessages];
    reconciled[nativeIndex] = withIdentity;
  }
  return reconciled;
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
  const rightIdentities = new Set(exactMessageIdentityKeys(right));
  return exactMessageIdentityKeys(left).some((identity) => rightIdentities.has(identity));
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

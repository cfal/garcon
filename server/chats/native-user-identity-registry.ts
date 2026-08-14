import {
  UserMessage,
  type ChatMessage,
  type ChatMessageMetadata,
} from '../../common/chat-types.js';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '../agents/shared/native-message-source.js';

export interface NativeUserIdentity {
  readonly clientRequestId: string;
  readonly clientMessageId?: string;
  readonly turnId?: string;
}

interface BindNativeUserPositionInput {
  readonly chatId: string;
  readonly messages: readonly UserMessage[];
  readonly position: {
    readonly previousNativeUserSourceKey: string | null;
    readonly userOffset: number;
  };
  readonly includesNativeStart: boolean;
  readonly identity: NativeUserIdentity;
}

export function nativeMessageSourceKey(message: ChatMessage): string | null {
  const source = getNativeMessageRevisionSource(message);
  if (!source || source.withinSourceOrdinal === undefined) return null;

  if (source.entryId) {
    return JSON.stringify(['native-entry', source.entryId, source.withinSourceOrdinal]);
  }
  if (source.byteOffset !== undefined) {
    return JSON.stringify(['native-byte', source.byteOffset, source.withinSourceOrdinal]);
  }
  if (source.lineNumber !== undefined) {
    return JSON.stringify(['native-line', source.lineNumber, source.withinSourceOrdinal]);
  }
  return null;
}

export class NativeUserIdentityRegistry {
  readonly #identityByChatAndSource = new Map<string, Map<string, NativeUserIdentity>>();
  readonly #identityByChatAndUserOrdinal = new Map<string, Map<number, NativeUserIdentity>>();

  bind(chatId: string, message: UserMessage, identity: NativeUserIdentity): boolean {
    const sourceKey = nativeMessageSourceKey(message);
    if (!sourceKey) return false;
    const identities = this.#identityByChatAndSource.get(chatId) ?? new Map();
    const existing = identities.get(sourceKey);
    if (existing && (
      existing.clientRequestId !== identity.clientRequestId
      || existing.clientMessageId !== identity.clientMessageId
      || existing.turnId !== identity.turnId
    )) {
      throw new Error('Native user source was bound to conflicting client identities');
    }
    identities.set(sourceKey, identity);
    this.#identityByChatAndSource.set(chatId, identities);
    return true;
  }

  bindPosition(input: BindNativeUserPositionInput): boolean {
    let previousIndex = -1;
    if (input.position.previousNativeUserSourceKey === null) {
      if (!input.includesNativeStart) return false;
    } else {
      previousIndex = input.messages.findIndex(
        (message) => nativeMessageSourceKey(message)
          === input.position.previousNativeUserSourceKey,
      );
      if (previousIndex < 0) return false;
    }

    const userOrdinal = previousIndex + input.position.userOffset;
    const message = input.messages[userOrdinal];
    if (!message || !this.bind(input.chatId, message, input.identity)) return false;
    if (input.includesNativeStart) {
      this.#setUserOrdinalIdentity(input.chatId, userOrdinal, input.identity);
    }
    return true;
  }

  apply(chatId: string, messages: readonly UserMessage[]): UserMessage[];
  apply(chatId: string, messages: readonly ChatMessage[]): ChatMessage[];
  apply(chatId: string, messages: readonly ChatMessage[]): ChatMessage[] {
    const identities = this.#identityByChatAndSource.get(chatId);
    if (!identities || identities.size === 0) return [...messages];

    return messages.map((message) => {
      if (!(message instanceof UserMessage)) return message;
      const sourceKey = nativeMessageSourceKey(message);
      const identity = sourceKey ? identities.get(sourceKey) : undefined;
      return identity ? applyNativeUserIdentity(message, identity) : message;
    });
  }

  applyFromNativeStart(chatId: string, messages: readonly UserMessage[]): UserMessage[];
  applyFromNativeStart(chatId: string, messages: readonly ChatMessage[]): ChatMessage[];
  applyFromNativeStart(chatId: string, messages: readonly ChatMessage[]): ChatMessage[] {
    const sourceIdentities = this.#identityByChatAndSource.get(chatId);
    const ordinalIdentities = this.#identityByChatAndUserOrdinal.get(chatId);
    if ((!sourceIdentities || sourceIdentities.size === 0)
        && (!ordinalIdentities || ordinalIdentities.size === 0)) {
      return [...messages];
    }

    let userOrdinal = 0;
    return messages.map((message) => {
      if (!(message instanceof UserMessage)) return message;
      const sourceKey = nativeMessageSourceKey(message);
      const sourceIdentity = sourceKey ? sourceIdentities?.get(sourceKey) : undefined;
      const identity = sourceIdentity ?? ordinalIdentities?.get(userOrdinal);
      if (sourceIdentity) {
        this.#setUserOrdinalIdentity(chatId, userOrdinal, sourceIdentity);
      } else if (identity && sourceKey) {
        this.bind(chatId, message, identity);
      }
      userOrdinal += 1;
      return identity ? applyNativeUserIdentity(message, identity) : message;
    });
  }

  copyChat(sourceChatId: string, targetChatId: string): void {
    const sourceIdentities = this.#identityByChatAndSource.get(sourceChatId);
    if (sourceIdentities) {
      this.#identityByChatAndSource.set(targetChatId, new Map(sourceIdentities));
    } else {
      this.#identityByChatAndSource.delete(targetChatId);
    }
    const ordinalIdentities = this.#identityByChatAndUserOrdinal.get(sourceChatId);
    if (ordinalIdentities) {
      this.#identityByChatAndUserOrdinal.set(targetChatId, new Map(ordinalIdentities));
    } else {
      this.#identityByChatAndUserOrdinal.delete(targetChatId);
    }
  }

  clearChat(chatId: string): void {
    this.#identityByChatAndSource.delete(chatId);
    this.#identityByChatAndUserOrdinal.delete(chatId);
  }

  #setUserOrdinalIdentity(
    chatId: string,
    userOrdinal: number,
    identity: NativeUserIdentity,
  ): void {
    const identities = this.#identityByChatAndUserOrdinal.get(chatId) ?? new Map();
    identities.set(userOrdinal, identity);
    this.#identityByChatAndUserOrdinal.set(chatId, identities);
  }
}

function applyNativeUserIdentity(
  message: UserMessage,
  identity: NativeUserIdentity,
): UserMessage {
  const metadata: ChatMessageMetadata = {
    ...message.metadata,
    clientRequestId: identity.clientRequestId,
    ...(identity.clientMessageId ? { upstreamRequestId: identity.clientMessageId } : {}),
    ...(identity.turnId ? { turnId: identity.turnId } : {}),
    deliveryStatus: 'accepted',
  };
  return attachNativeMessageSource(
    new UserMessage(message.timestamp, message.content, message.images, metadata),
    getNativeMessageRevisionSource(message),
  );
}

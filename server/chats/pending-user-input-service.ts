import crypto from 'crypto';
import {
  UserMessage,
  type ChatImage,
  type ChatMessage,
  type UserMessageDeliveryStatus,
} from '../../common/chat-types.js';
import type { PendingUserInput, PendingUserInputClearReason } from '../../common/pending-user-input.js';
import { PendingUserInputStore } from './pending-user-input-store.js';
import type { PendingInputHistoryReader } from './chat-message-reader.js';

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

const PENDING_ECHO_MAX_BEFORE_MS = 30 * 1000;
const PENDING_ECHO_MAX_AFTER_MS = 5 * 60 * 1000;

function imagesMatch(left: ChatImage[] | undefined, right: ChatImage[] | undefined): boolean {
  const leftImages = left ?? [];
  const rightImages = right ?? [];
  return leftImages.length === rightImages.length && leftImages.every((image, index) => {
    const candidate = rightImages[index];
    return candidate !== undefined
      && image.data === candidate.data
      && image.name === candidate.name
      && image.mimeType === candidate.mimeType;
  });
}

function isUnidentifiedPendingEcho(record: PendingUserInput, message: UserMessage): boolean {
  if (message.metadata?.clientRequestId) return false;
  if (
    record.turnId
    && message.metadata?.turnId
    && record.turnId !== message.metadata.turnId
  ) {
    return false;
  }
  if (record.content !== message.content || !imagesMatch(record.images, message.images)) return false;
  const pendingAt = Date.parse(record.createdAt);
  const messageAt = Date.parse(message.timestamp);
  return Number.isFinite(pendingAt)
    && Number.isFinite(messageAt)
    && messageAt >= pendingAt - PENDING_ECHO_MAX_BEFORE_MS
    && messageAt <= pendingAt + PENDING_ECHO_MAX_AFTER_MS;
}

function matchingRequestIds(
  records: PendingUserInput[],
  messages: UserMessage[],
): Set<string> {
  const matchedMessageIndexes = new Set<number>();
  const requestIds = new Set<string>();

  for (const record of records) {
    let messageIndex = messages.findIndex(
      (message, index) =>
        !matchedMessageIndexes.has(index)
        && message.metadata?.clientRequestId === record.clientRequestId,
    );
    if (messageIndex < 0) {
      messageIndex = messages.findIndex(
        (message, index) =>
          !matchedMessageIndexes.has(index)
          && isUnidentifiedPendingEcho(record, message),
      );
    }
    if (messageIndex < 0) continue;
    matchedMessageIndexes.add(messageIndex);
    requestIds.add(record.clientRequestId);
  }

  return requestIds;
}

function userMessages(messages: ChatMessage[] | null): UserMessage[] {
  return (messages ?? []).filter(
    (message): message is UserMessage => message instanceof UserMessage,
  );
}

export interface RegisterPendingUserInputOptions {
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
  images?: ChatImage[];
  createdAt?: string;
  deliveryStatus?: UserMessageDeliveryStatus;
}

export interface PendingUserInputServiceContract {
  listForChat(chatId: string): PendingUserInput[];
  clearChat(chatId: string, reason?: PendingUserInputClearReason): void;
  discardChat(chatId: string): number;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  register(chatId: string, content: string, options?: RegisterPendingUserInputOptions): Promise<PendingUserInput>;
  reconcileRetainedHistory(chatId: string): Promise<void>;
  reconcileNativeHistory(chatId: string): Promise<void>;
}

export class PendingUserInputService implements PendingUserInputServiceContract {
  readonly store = new PendingUserInputStore();
  #messages: PendingInputHistoryReader;
  #nativeReconcileByChatId = new Map<string, Promise<void>>();

  constructor(messages: PendingInputHistoryReader) {
    this.#messages = messages;
  }

  listForChat(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId);
  }

  clearChat(chatId: string, reason: PendingUserInputClearReason = 'chat-removed'): void {
    this.store.clearChat(chatId, reason);
  }

  discardChat(chatId: string): number {
    return this.store.discardChat(chatId);
  }

  discard(chatId: string, clientRequestId: string): boolean {
    return this.store.discard(chatId, clientRequestId);
  }

  markFailed(chatId: string, clientRequestId: string): boolean {
    const record = this.store
      .listRecordsForChat(chatId)
      .find((input) => input.clientRequestId === clientRequestId);
    if (!record) return false;
    this.store.upsert({ ...record, deliveryStatus: 'failed' });
    return true;
  }

  async register(chatId: string, content: string, options: RegisterPendingUserInputOptions = {}): Promise<PendingUserInput> {
    await this.reconcileRetainedHistory(chatId);
    const input: PendingUserInput = {
      chatId,
      clientRequestId: options.clientRequestId ?? crypto.randomUUID(),
      content: String(content),
      createdAt: options.createdAt ?? new Date().toISOString(),
      deliveryStatus: options.deliveryStatus ?? 'accepted',
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.images ? { images: options.images } : {}),
    };
    return this.store.upsert(input);
  }

  async reconcileRetainedHistory(chatId: string): Promise<void> {
    const records = this.#reconcilableRecords(chatId);
    if (records.length === 0) return;
    this.#clearMatches(
      chatId,
      records,
      userMessages(this.#messages.getRetainedHistoryMessages(chatId)),
    );
  }

  async reconcileNativeHistory(chatId: string): Promise<void> {
    if (!this.store.hasRecordsForChat(chatId)) return;

    const inFlight = this.#nativeReconcileByChatId.get(chatId);
    if (inFlight) return inFlight;

    const reconcilePromise = (async () => {
      const records = this.#reconcilableRecords(chatId);
      if (records.length === 0) return;

      try {
        const nativeMessages = await this.#messages.loadNativeMessages(chatId);
        this.#clearMatches(chatId, records, userMessages(nativeMessages));
      } catch {
        this.#clearMatches(
          chatId,
          records,
          userMessages(this.#messages.getRetainedHistoryMessages(chatId)),
        );
      }
    })();

    this.#nativeReconcileByChatId.set(chatId, reconcilePromise);
    try {
      await reconcilePromise;
    } finally {
      this.#nativeReconcileByChatId.delete(chatId);
    }
  }

  #reconcilableRecords(chatId: string): PendingUserInput[] {
    return this.store
      .listRecordsForChat(chatId)
      .filter((record) => record.deliveryStatus !== 'failed')
      .sort(byCreatedAt);
  }

  #clearMatches(
    chatId: string,
    records: PendingUserInput[],
    messages: UserMessage[],
  ): void {
    for (const clientRequestId of matchingRequestIds(records, messages)) {
      this.store.clear(chatId, clientRequestId, 'persisted');
    }
  }
}

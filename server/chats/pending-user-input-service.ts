import crypto from 'crypto';
import { UserMessage, type ChatImage, type UserMessageDeliveryStatus } from '../../common/chat-types.js';
import type { PendingUserInput, PendingUserInputClearReason } from '../../common/pending-user-input.js';
import { PendingUserInputStore } from './pending-user-input-store.js';
import type { ChatMessageReader } from './chat-message-reader.js';

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
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
  updateDeliveryStatus(chatId: string, clientRequestId: string, deliveryStatus: UserMessageDeliveryStatus): PendingUserInput | null;
  register(chatId: string, content: string, options?: RegisterPendingUserInputOptions): Promise<PendingUserInput>;
  reconcile(chatId: string): Promise<void>;
}

export class PendingUserInputService implements PendingUserInputServiceContract {
  readonly store = new PendingUserInputStore();
  #messages: ChatMessageReader;
  #reconcileByChatId = new Map<string, Promise<void>>();

  constructor(messages: ChatMessageReader) {
    this.#messages = messages;
  }

  listForChat(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId);
  }

  clearChat(chatId: string, reason: PendingUserInputClearReason = 'chat-removed'): void {
    this.store.clearChat(chatId, reason);
  }

  updateDeliveryStatus(chatId: string, clientRequestId: string, deliveryStatus: UserMessageDeliveryStatus): PendingUserInput | null {
    return this.store.updateDeliveryStatus(chatId, clientRequestId, deliveryStatus);
  }

  async register(chatId: string, content: string, options: RegisterPendingUserInputOptions = {}): Promise<PendingUserInput> {
    await this.reconcile(chatId);
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

  async reconcile(chatId: string): Promise<void> {
    if (!this.store.hasRecordsForChat(chatId)) return;

    const inFlight = this.#reconcileByChatId.get(chatId);
    if (inFlight) return inFlight;

    const reconcilePromise = (async () => {
      let messages = this.#messages.getMessages(chatId);
      try {
        await this.#messages.ensureLoaded(chatId);
        messages = this.#messages.getMessages(chatId);
      } catch {
        // Falls back to the currently loaded transcript when native reload fails.
      }

      const echoedClientRequestIds = new Set<string>();
      for (const message of messages ?? []) {
        if (message instanceof UserMessage && message.metadata?.clientRequestId) {
          echoedClientRequestIds.add(message.metadata.clientRequestId);
        }
      }
      const records = this.store
        .listRecordsForChat(chatId)
        .filter((record) => record.deliveryStatus !== 'failed')
        .sort(byCreatedAt);

      for (const record of records) {
        if (echoedClientRequestIds.has(record.clientRequestId)) {
          this.store.clear(chatId, record.clientRequestId, 'persisted');
        }
      }
    })();

    this.#reconcileByChatId.set(chatId, reconcilePromise);
    try {
      await reconcilePromise;
    } finally {
      this.#reconcileByChatId.delete(chatId);
    }
  }
}

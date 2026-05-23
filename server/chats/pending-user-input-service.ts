import crypto from 'crypto';
import type { ChatImage, UserMessageDeliveryStatus } from '../../common/chat-types.js';
import type { PendingUserInput, PendingUserInputClearReason } from '../../common/pending-user-input.js';
import { PendingUserInputStore, type PendingUserCheckpoint } from './pending-user-input-store.js';

interface HistoryCacheDep {
  ensureLoaded(chatId: string): Promise<unknown>;
  getMessages(chatId: string): unknown[] | null;
}

function durableUserCount(messages: unknown[] | null | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'user-message') {
      count += 1;
    }
  }
  return count;
}

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

export class PendingUserInputService {
  readonly store = new PendingUserInputStore();
  #historyCache: HistoryCacheDep;
  #reconcileByChatId = new Map<string, Promise<void>>();

  constructor(historyCache: HistoryCacheDep) {
    this.#historyCache = historyCache;
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
    const checkpoint = await this.#checkpointFor(chatId);
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
    return this.store.upsert(input, checkpoint);
  }

  async reconcile(chatId: string): Promise<void> {
    if (!this.store.hasRecordsForChat(chatId)) return;

    const inFlight = this.#reconcileByChatId.get(chatId);
    if (inFlight) return inFlight;

    const reconcilePromise = (async () => {
      let messages = this.#historyCache.getMessages(chatId);
      try {
        await this.#historyCache.ensureLoaded(chatId);
        messages = this.#historyCache.getMessages(chatId);
      } catch {
        // Falls back to the current cached history when agent reload fails.
      }

      const persistedUserCount = durableUserCount(messages);
      const records = this.store
        .listRecordsForChat(chatId)
        .filter((record) => record.deliveryStatus !== 'failed')
        .sort(byCreatedAt);
      let previousRequiredCount = 0;

      for (const record of records) {
        const requiredCount = Math.max(record.checkpoint.userMessageCount + 1, previousRequiredCount + 1);
        previousRequiredCount = requiredCount;
        if (persistedUserCount >= requiredCount) {
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

  async #checkpointFor(chatId: string): Promise<PendingUserCheckpoint> {
    try {
      await this.#historyCache.ensureLoaded(chatId);
    } catch {
      // Falls back to the current cached history when agent reload fails.
    }
    return {
      createdAt: new Date().toISOString(),
      userMessageCount: durableUserCount(this.#historyCache.getMessages(chatId)),
    };
  }
}

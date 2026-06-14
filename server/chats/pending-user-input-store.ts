import { EventEmitter } from 'events';
import type { PendingUserInput, PendingUserInputClearReason } from '../../common/pending-user-input.js';
import type { UserMessageDeliveryStatus } from '../../common/chat-types.js';

export type PendingUserInputRecord = PendingUserInput;

type UpdatedCallback = (input: PendingUserInput) => void;
type ClearedCallback = (chatId: string, clientRequestId: string, reason: PendingUserInputClearReason) => void;

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function clonePendingInput(record: PendingUserInputRecord): PendingUserInput {
  return {
    chatId: record.chatId,
    clientRequestId: record.clientRequestId,
    content: record.content,
    createdAt: record.createdAt,
    deliveryStatus: record.deliveryStatus,
    ...(record.clientMessageId ? { clientMessageId: record.clientMessageId } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    ...(record.images ? { images: record.images } : {}),
  };
}

export class PendingUserInputStore extends EventEmitter {
  #recordsByChatId = new Map<string, PendingUserInputRecord[]>();

  listForChat(chatId: string): PendingUserInput[] {
    return (this.#recordsByChatId.get(chatId) ?? [])
      .slice()
      .sort(byCreatedAt)
      .map(clonePendingInput);
  }

  listRecordsForChat(chatId: string): PendingUserInputRecord[] {
    return (this.#recordsByChatId.get(chatId) ?? []).slice().sort(byCreatedAt);
  }

  hasRecordsForChat(chatId: string): boolean {
    return (this.#recordsByChatId.get(chatId)?.length ?? 0) > 0;
  }

  upsert(input: PendingUserInput): PendingUserInput {
    const records = this.#recordsByChatId.get(input.chatId) ?? [];
    const index = records.findIndex((record) => record.clientRequestId === input.clientRequestId);
    const next: PendingUserInputRecord = { ...input };
    if (index >= 0) {
      records[index] = {
        ...records[index],
        ...next,
      };
    } else {
      records.push(next);
    }
    records.sort(byCreatedAt);
    this.#recordsByChatId.set(input.chatId, records);
    const stored = records.find((record) => record.clientRequestId === input.clientRequestId) ?? next;
    const normalized = clonePendingInput(stored);
    this.emit('updated', normalized);
    return normalized;
  }

  updateDeliveryStatus(
    chatId: string,
    clientRequestId: string,
    deliveryStatus: UserMessageDeliveryStatus,
  ): PendingUserInput | null {
    const records = this.#recordsByChatId.get(chatId);
    if (!records) return null;
    const index = records.findIndex((record) => record.clientRequestId === clientRequestId);
    if (index < 0) return null;
    const current = records[index];
    if (current.deliveryStatus === deliveryStatus) return clonePendingInput(current);
    const next: PendingUserInputRecord = {
      ...current,
      deliveryStatus,
    };
    records[index] = next;
    this.emit('updated', clonePendingInput(next));
    return clonePendingInput(next);
  }

  clear(chatId: string, clientRequestId: string, reason: PendingUserInputClearReason): boolean {
    const records = this.#recordsByChatId.get(chatId);
    if (!records) return false;
    const next = records.filter((record) => record.clientRequestId !== clientRequestId);
    if (next.length === records.length) return false;
    if (next.length > 0) {
      this.#recordsByChatId.set(chatId, next);
    } else {
      this.#recordsByChatId.delete(chatId);
    }
    this.emit('cleared', chatId, clientRequestId, reason);
    return true;
  }

  discard(chatId: string, clientRequestId: string): boolean {
    const records = this.#recordsByChatId.get(chatId);
    if (!records) return false;
    const next = records.filter((record) => record.clientRequestId !== clientRequestId);
    if (next.length === records.length) return false;
    if (next.length > 0) {
      this.#recordsByChatId.set(chatId, next);
    } else {
      this.#recordsByChatId.delete(chatId);
    }
    return true;
  }

  clearChat(chatId: string, reason: PendingUserInputClearReason): void {
    const records = this.#recordsByChatId.get(chatId);
    if (!records || records.length === 0) return;
    this.#recordsByChatId.delete(chatId);
    for (const record of records) {
      this.emit('cleared', chatId, record.clientRequestId, reason);
    }
  }

  discardChat(chatId: string): number {
    const records = this.#recordsByChatId.get(chatId);
    if (!records || records.length === 0) return 0;
    this.#recordsByChatId.delete(chatId);
    return records.length;
  }

  onUpdated(callback: UpdatedCallback): void {
    this.on('updated', callback);
  }

  onCleared(callback: ClearedCallback): void {
    this.on('cleared', callback);
  }
}

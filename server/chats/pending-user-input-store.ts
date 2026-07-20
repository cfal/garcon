import { EventEmitter } from 'events';
import type { UserMessageDeliveryStatus } from '../../common/chat-types.js';
import type {
  PendingUserInput,
  PendingUserInputClearReason,
} from '../../common/pending-user-input.js';

export type PendingUserInputRecord = PendingUserInput;
export type PendingUserInputStoreClearReason = PendingUserInputClearReason;

type UpdatedCallback = (input: PendingUserInput) => void;
type StatusUpdatedCallback = (
  chatId: string,
  clientRequestId: string,
  deliveryStatus: UserMessageDeliveryStatus,
) => void;
type ClearedCallback = (chatId: string, clientRequestId: string, reason: PendingUserInputStoreClearReason) => void;

interface PendingUserInputEvents {
  updated: Parameters<UpdatedCallback>;
  'status-updated': Parameters<StatusUpdatedCallback>;
  cleared: Parameters<ClearedCallback>;
}

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
    ...(record.attachments ? { attachments: record.attachments } : {}),
  };
}

export class PendingUserInputStore extends EventEmitter<PendingUserInputEvents> {
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

  upsert(input: PendingUserInputRecord): PendingUserInput {
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
  ): boolean {
    const records = this.#recordsByChatId.get(chatId);
    const record = records?.find((candidate) => candidate.clientRequestId === clientRequestId);
    if (!record) return false;
    if (record.deliveryStatus === deliveryStatus) return true;
    record.deliveryStatus = deliveryStatus;
    this.emit('status-updated', chatId, clientRequestId, deliveryStatus);
    return true;
  }

  isCurrentRecord(chatId: string, record: PendingUserInputRecord): boolean {
    return this.#recordsByChatId.get(chatId)?.some((candidate) => candidate === record) ?? false;
  }

  updateDeliveryStatusIfCurrent(
    chatId: string,
    record: PendingUserInputRecord,
    deliveryStatus: UserMessageDeliveryStatus,
  ): boolean {
    if (!this.isCurrentRecord(chatId, record)) return false;
    return this.updateDeliveryStatus(chatId, record.clientRequestId, deliveryStatus);
  }

  clear(chatId: string, clientRequestId: string, reason: PendingUserInputStoreClearReason): boolean {
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

  onStatusUpdated(callback: StatusUpdatedCallback): void {
    this.on('status-updated', callback);
  }

  onCleared(callback: ClearedCallback): void {
    this.on('cleared', callback);
  }
}

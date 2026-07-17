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

interface IdentitylessEvidenceClaim {
  count: number;
  messageAt: number;
}

interface PendingInputMatches {
  requestIds: Set<string>;
  identitylessEvidence: Map<string, IdentitylessEvidenceClaim>;
}

function identitylessEvidenceKey(message: UserMessage): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    timestamp: message.timestamp,
    content: message.content,
    images: message.images ?? [],
    turnId: message.metadata?.turnId ?? null,
  })).digest('hex');
}

function matchingRequestIds(
  records: PendingUserInput[],
  messages: UserMessage[],
  claimedIdentitylessEvidence: ReadonlyMap<string, IdentitylessEvidenceClaim>,
): PendingInputMatches {
  const matchedMessageIndexes = new Set<number>();
  const requestIds = new Set<string>();
  const identitylessEvidence = new Map<string, IdentitylessEvidenceClaim>();
  const identitylessOccurrences = new Map<number, { key: string; occurrence: number; messageAt: number }>();
  const occurrenceCounts = new Map<string, number>();

  messages.forEach((message, index) => {
    if (message.metadata?.clientRequestId) return;
    const key = identitylessEvidenceKey(message);
    const occurrence = (occurrenceCounts.get(key) ?? 0) + 1;
    occurrenceCounts.set(key, occurrence);
    identitylessOccurrences.set(index, {
      key,
      occurrence,
      messageAt: Date.parse(message.timestamp),
    });
  });

  for (const record of records) {
    let messageIndex = messages.findIndex(
      (message, index) =>
        !matchedMessageIndexes.has(index)
        && message.metadata?.clientRequestId === record.clientRequestId,
    );
    if (messageIndex < 0) {
      messageIndex = messages.findIndex(
        (message, index) => {
          if (matchedMessageIndexes.has(index) || !isUnidentifiedPendingEcho(record, message)) {
            return false;
          }
          const evidence = identitylessOccurrences.get(index);
          return evidence !== undefined
            && evidence.occurrence > (claimedIdentitylessEvidence.get(evidence.key)?.count ?? 0);
        },
      );
    }
    if (messageIndex < 0) continue;
    matchedMessageIndexes.add(messageIndex);
    requestIds.add(record.clientRequestId);
    const evidence = identitylessOccurrences.get(messageIndex);
    if (evidence) {
      const prior = identitylessEvidence.get(evidence.key);
      identitylessEvidence.set(evidence.key, {
        count: (prior?.count ?? 0) + 1,
        messageAt: evidence.messageAt,
      });
    }
  }

  return { requestIds, identitylessEvidence };
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
  listForTransport(chatId: string): PendingUserInput[];
  clearChat(chatId: string, reason?: PendingUserInputClearReason): void;
  discardChat(chatId: string): number;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  markUnpersistedFailed(chatId: string): number;
  register(chatId: string, content: string, options?: RegisterPendingUserInputOptions): Promise<PendingUserInput>;
  reconcileRetainedHistory(chatId: string): Promise<void>;
  reconcileNativeHistory(chatId: string): Promise<void>;
  settleAfterStop(chatId: string): Promise<void>;
}

export class PendingUserInputService implements PendingUserInputServiceContract {
  readonly store = new PendingUserInputStore();
  #messages: PendingInputHistoryReader;
  #nativeReconcileByChatId = new Map<string, Promise<void>>();
  #claimedIdentitylessEvidenceByChatId = new Map<string, Map<string, IdentitylessEvidenceClaim>>();

  constructor(messages: PendingInputHistoryReader) {
    this.#messages = messages;
  }

  listForChat(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId);
  }

  listForTransport(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId).map(({ images: _images, ...input }) => input);
  }

  clearChat(chatId: string, reason: PendingUserInputClearReason = 'chat-removed'): void {
    this.store.clearChat(chatId, reason);
    this.#claimedIdentitylessEvidenceByChatId.delete(chatId);
  }

  discardChat(chatId: string): number {
    const discarded = this.store.discardChat(chatId);
    this.#claimedIdentitylessEvidenceByChatId.delete(chatId);
    return discarded;
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

  markUnpersistedFailed(chatId: string): number {
    let marked = 0;
    for (const record of this.store.listRecordsForChat(chatId)) {
      if (record.deliveryStatus === 'failed') continue;
      this.store.upsert({ ...record, deliveryStatus: 'failed' });
      marked += 1;
    }
    return marked;
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
    const registered = this.store.upsert(input);
    this.#pruneIdentitylessEvidence(chatId);
    return registered;
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

  async settleAfterStop(chatId: string): Promise<void> {
    await this.reconcileNativeHistory(chatId);
    this.markUnpersistedFailed(chatId);
  }

  #reconcilableRecords(chatId: string): PendingUserInput[] {
    return this.store
      .listRecordsForChat(chatId)
      .sort(byCreatedAt);
  }

  #clearMatches(
    chatId: string,
    records: PendingUserInput[],
    messages: UserMessage[],
  ): void {
    const claimedEvidence = this.#claimedIdentitylessEvidenceByChatId.get(chatId) ?? new Map();
    const matches = matchingRequestIds(records, messages, claimedEvidence);
    for (const [key, evidence] of matches.identitylessEvidence) {
      const prior = claimedEvidence.get(key);
      claimedEvidence.set(key, {
        count: (prior?.count ?? 0) + evidence.count,
        messageAt: evidence.messageAt,
      });
    }
    if (claimedEvidence.size > 0) {
      this.#claimedIdentitylessEvidenceByChatId.set(chatId, claimedEvidence);
    }
    for (const clientRequestId of matches.requestIds) {
      this.store.clear(chatId, clientRequestId, 'persisted');
    }
  }

  #pruneIdentitylessEvidence(chatId: string): void {
    const claims = this.#claimedIdentitylessEvidenceByChatId.get(chatId);
    if (!claims || claims.size === 0) return;
    const earliestPendingAt = this.store
      .listRecordsForChat(chatId)
      .map((record) => Date.parse(record.createdAt))
      .filter(Number.isFinite)
      .reduce((earliest, createdAt) => Math.min(earliest, createdAt), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliestPendingAt)) return;
    const oldestRelevantEvidenceAt = earliestPendingAt - PENDING_ECHO_MAX_BEFORE_MS;
    for (const [key, claim] of claims) {
      if (claim.messageAt < oldestRelevantEvidenceAt) claims.delete(key);
    }
    if (claims.size === 0) this.#claimedIdentitylessEvidenceByChatId.delete(chatId);
  }
}

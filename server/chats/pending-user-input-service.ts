import crypto from 'crypto';
import {
  UserMessage,
  type ChatImage,
  type ChatMessage,
  type UserMessageDeliveryStatus,
} from '../../common/chat-types.js';
import type {
  PendingUserInput,
  PendingUserInputAttachment,
  PendingUserInputClearReason,
} from '../../common/pending-user-input.js';
import {
  PendingUserInputStore,
  type PendingUserInputImageEvidence,
  type PendingUserInputRecord,
} from './pending-user-input-store.js';
import type { PendingInputHistoryReader } from './chat-message-reader.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

const PENDING_ECHO_MAX_BEFORE_MS = 30 * 1000;
const PENDING_ECHO_MAX_AFTER_MS = 5 * 60 * 1000;

function imageEvidence(images: ChatImage[] | undefined): PendingUserInputImageEvidence[] {
  return (images ?? []).map((image) => ({
    name: image.name,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    dataSha256: crypto.createHash('sha256').update(image.data).digest('hex'),
    dataLength: image.data.length,
  }));
}

function imagesMatch(record: PendingUserInputRecord, images: ChatImage[] | undefined): boolean {
  const leftImages = record.imageEvidence ?? imageEvidence(record.images);
  const rightImages = imageEvidence(images);
  return leftImages.length === rightImages.length && leftImages.every((image, index) => {
    const candidate = rightImages[index];
    return candidate !== undefined
      && image.dataSha256 === candidate.dataSha256
      && image.dataLength === candidate.dataLength
      && image.name === candidate.name
      && image.mimeType === candidate.mimeType;
  });
}

function isUnidentifiedPendingEcho(record: PendingUserInputRecord, message: UserMessage): boolean {
  if (message.metadata?.clientRequestId) return false;
  if (
    record.turnId
    && message.metadata?.turnId
    && record.turnId !== message.metadata.turnId
  ) {
    return false;
  }
  if (record.content !== message.content || !imagesMatch(record, message.images)) return false;
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
  records: PendingUserInputRecord[],
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

export interface RestorePendingUserInput {
  chatId: string;
  clientRequestId: string;
  content: string;
  createdAt: string;
  clientMessageId?: string;
  turnId?: string;
  attachments?: PendingUserInputAttachment[];
  imageEvidence?: PendingUserInputImageEvidence[];
}

export interface PendingUserInputCohort {
  readonly chatId: string;
  readonly records: readonly PendingUserInputRecord[];
}

export interface PendingUserInputServiceContract {
  listForChat(chatId: string): PendingUserInput[];
  listForTransport(chatId: string): PendingUserInput[];
  clearChat(chatId: string, reason?: PendingUserInputClearReason): void;
  discardChat(chatId: string): number;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  register(chatId: string, content: string, options?: RegisterPendingUserInputOptions): Promise<PendingUserInput>;
  captureCohort(chatId: string): PendingUserInputCohort;
  reconcileRetainedHistory(chatId: string): Promise<void>;
  reconcileNativeHistory(chatId: string): Promise<void>;
  settleNativeCohort(cohort: PendingUserInputCohort): Promise<void>;
  settleRetainedCohort(cohort: PendingUserInputCohort): void;
}

export class PendingUserInputService implements PendingUserInputServiceContract {
  readonly store = new PendingUserInputStore();
  #messages: PendingInputHistoryReader;
  #nativeEvidenceLock = new KeyedPromiseLock();
  #claimedIdentitylessEvidenceByChatId = new Map<string, Map<string, IdentitylessEvidenceClaim>>();

  constructor(messages: PendingInputHistoryReader) {
    this.#messages = messages;
  }

  listForChat(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId);
  }

  listForTransport(chatId: string): PendingUserInput[] {
    return this.store.listForChat(chatId).map(({ images, attachments, ...input }) => ({
      ...input,
      ...((attachments?.length ?? 0) > 0
        ? { attachments }
        : (images?.length ?? 0) > 0
          ? {
            attachments: images?.map((image) => ({
              name: image.name,
              ...(image.mimeType ? { mimeType: image.mimeType } : {}),
            })),
          }
          : {}),
    }));
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
    return this.store.updateDeliveryStatus(chatId, clientRequestId, 'failed');
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

  restoreUnconfirmed(input: RestorePendingUserInput): PendingUserInput {
    const record: PendingUserInputRecord = {
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      content: input.content,
      createdAt: input.createdAt,
      deliveryStatus: 'unconfirmed',
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.imageEvidence?.length ? { imageEvidence: input.imageEvidence } : {}),
    };
    return this.store.upsert(record);
  }

  captureCohort(chatId: string): PendingUserInputCohort {
    return Object.freeze({
      chatId,
      records: Object.freeze(this.#reconcilableRecords(chatId)),
    });
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

    await this.#nativeEvidenceLock.runExclusive(chatId, async () => {
      const cohort = this.captureCohort(chatId);
      const records = this.#currentCohortRecords(cohort);
      if (records.length === 0) return;

      try {
        const nativeMessages = await this.#messages.loadNativeMessages(chatId);
        this.#clearMatches(chatId, this.#currentCohortRecords(cohort), userMessages(nativeMessages));
      } catch {
        this.#clearMatches(
          chatId,
          this.#currentCohortRecords(cohort),
          userMessages(this.#messages.getRetainedHistoryMessages(chatId)),
        );
      }
    });
  }

  async settleNativeCohort(cohort: PendingUserInputCohort): Promise<void> {
    await this.#nativeEvidenceLock.runExclusive(cohort.chatId, async () => {
      const records = this.#currentCohortRecords(cohort);
      if (records.length === 0) return;

      try {
        const nativeMessages = await this.#messages.loadNativeMessages(cohort.chatId);
        this.#settleCohort(cohort, userMessages(nativeMessages));
      } catch {
        this.#settleCohort(
          cohort,
          userMessages(this.#messages.getRetainedHistoryMessages(cohort.chatId)),
        );
      }
    });
  }

  settleRetainedCohort(cohort: PendingUserInputCohort): void {
    this.#settleCohort(
      cohort,
      userMessages(this.#messages.getRetainedHistoryMessages(cohort.chatId)),
    );
  }

  #reconcilableRecords(chatId: string): PendingUserInputRecord[] {
    return this.store
      .listRecordsForChat(chatId)
      .sort(byCreatedAt);
  }

  #currentCohortRecords(cohort: PendingUserInputCohort): PendingUserInputRecord[] {
    return cohort.records.filter((record) => this.store.isCurrentRecord(cohort.chatId, record));
  }

  #settleCohort(cohort: PendingUserInputCohort, messages: UserMessage[]): void {
    this.#clearMatches(cohort.chatId, this.#currentCohortRecords(cohort), messages);
    for (const record of this.#currentCohortRecords(cohort)) {
      if (record.deliveryStatus === 'failed') continue;
      this.store.updateDeliveryStatusIfCurrent(cohort.chatId, record, 'unconfirmed');
    }
  }

  #clearMatches(
    chatId: string,
    records: PendingUserInputRecord[],
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

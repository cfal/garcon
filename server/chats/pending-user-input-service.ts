import crypto from 'crypto';
import {
  type ChatImage,
  type UserMessage,
  type UserMessageDeliveryStatus,
} from '../../common/chat-types.js';
import type {
  PendingUserInput,
  PendingUserInputClearReason,
} from '../../common/pending-user-input.js';
import { isPendingUserInputInFlight } from '../../common/pending-user-input.js';
import {
  PendingUserInputStore,
  type PendingUserInputRecord,
} from './pending-user-input-store.js';
import type { PendingInputHistoryReader } from './chat-message-reader.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import { matchingRequestIds } from './pending-input-matching.js';
import {
  nativeUserMessages,
  scanCurrentNativeUserEvidence,
} from './native-pending-evidence-scanner.js';
import type { PendingNativeUserPosition } from './chat-view-contracts.js';
import { NativeUserIdentityRegistry } from './native-user-identity-registry.js';

const logger = createLogger('pending-inputs');

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function positionAfterOmittedFailedPredecessors(
  record: PendingUserInputRecord,
  precedingRecords: readonly PendingUserInputRecord[],
  exactRequestIds: ReadonlySet<string>,
): PendingNativeUserPosition | null {
  const position = record.nativeUserPosition;
  if (
    !position
    || record.deliveryStatus === 'failed'
    || exactRequestIds.has(record.clientRequestId)
  ) {
    return null;
  }

  let userOffset = position.userOffset;
  for (const predecessor of precedingRecords) {
    if (
      predecessor.deliveryStatus !== 'failed'
      || exactRequestIds.has(predecessor.clientRequestId)
      || predecessor.nativeUserPosition?.previousNativeUserSourceKey
        !== position.previousNativeUserSourceKey
      || predecessor.nativeUserPosition.userOffset >= position.userOffset
    ) {
      continue;
    }
    userOffset -= 1;
  }
  return { ...position, userOffset };
}

export interface RegisterPendingUserInputOptions {
  clientRequestId?: string;
  clientMessageId?: string;
  turnId?: string;
  images?: ChatImage[];
  createdAt?: string;
  deliveryStatus?: UserMessageDeliveryStatus;
}

export interface PendingUserInputCohort {
  readonly chatId: string;
  readonly records: readonly PendingUserInputRecord[];
}

interface NativeReconcileRun {
  dirty: boolean;
  promise: Promise<void>;
}

export interface PendingUserInputServiceContract {
  listForChat(chatId: string): PendingUserInput[];
  listForTransport(chatId: string): PendingUserInput[];
  hasInFlightForChat(chatId: string): boolean;
  clearChat(chatId: string, reason?: PendingUserInputClearReason): void;
  discardChat(chatId: string): number;
  discard(chatId: string, clientRequestId: string): boolean;
  markFailed(chatId: string, clientRequestId: string): boolean;
  markUnconfirmed(chatId: string, clientRequestId: string): boolean;
  bindNativeUserPosition(
    chatId: string,
    clientRequestId: string,
    position: PendingNativeUserPosition,
  ): boolean;
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
  #nativeUserIdentities: NativeUserIdentityRegistry;
  #nativeEvidenceLock = new KeyedPromiseLock();
  #nativeReconcileByChatId = new Map<string, NativeReconcileRun>();

  constructor(
    messages: PendingInputHistoryReader,
    nativeUserIdentities = new NativeUserIdentityRegistry(),
  ) {
    this.#messages = messages;
    this.#nativeUserIdentities = nativeUserIdentities;
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

  hasInFlightForChat(chatId: string): boolean {
    return this.store
      .listRecordsForChat(chatId)
      .some((record) => isPendingUserInputInFlight(record.deliveryStatus));
  }

  clearChat(chatId: string, reason: PendingUserInputClearReason = 'chat-removed'): void {
    this.store.clearChat(chatId, reason);
    this.#nativeUserIdentities.clearChat(chatId);
  }

  discardChat(chatId: string): number {
    return this.store.discardChat(chatId);
  }

  discard(chatId: string, clientRequestId: string): boolean {
    return this.store.discard(chatId, clientRequestId);
  }

  markFailed(chatId: string, clientRequestId: string): boolean {
    return this.store.updateDeliveryStatus(chatId, clientRequestId, 'failed');
  }

  markUnconfirmed(chatId: string, clientRequestId: string): boolean {
    return this.store.updateDeliveryStatus(chatId, clientRequestId, 'unconfirmed');
  }

  bindNativeUserPosition(
    chatId: string,
    clientRequestId: string,
    position: PendingNativeUserPosition,
  ): boolean {
    return this.store.bindNativeUserPosition(chatId, clientRequestId, position);
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
      nativeUserMessages(this.#messages.getRetainedHistoryMessages(chatId)),
      this.#messages.hasCompleteHistory?.(chatId) === true,
    );
  }

  async reconcileNativeHistory(chatId: string): Promise<void> {
    if (!this.store.hasRecordsForChat(chatId)) return;
    const existing = this.#nativeReconcileByChatId.get(chatId);
    if (existing) {
      existing.dirty = true;
      return existing.promise;
    }

    let resolveRun!: () => void;
    let rejectRun!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const run = { dirty: false, promise };
    this.#nativeReconcileByChatId.set(chatId, run);
    this.#runNativeReconcile(chatId, run).then(resolveRun, rejectRun).finally(() => {
      if (this.#nativeReconcileByChatId.get(chatId) === run) {
        this.#nativeReconcileByChatId.delete(chatId);
      }
    });
    return promise;
  }

  async #runNativeReconcile(chatId: string, run: NativeReconcileRun): Promise<void> {
    do {
      run.dirty = false;
      await this.#reconcileNativeHistoryOnce(chatId);
    } while (run.dirty && this.store.hasRecordsForChat(chatId));
  }

  async #reconcileNativeHistoryOnce(chatId: string): Promise<void> {
    try {
      await this.#reconcileNativeHistoryStrictOnce(chatId);
    } catch {
      const cohort = this.captureCohort(chatId);
      this.#clearMatches(
        chatId,
        this.#currentCohortRecords(cohort),
        nativeUserMessages(this.#messages.getRetainedHistoryMessages(chatId)),
        this.#messages.hasCompleteHistory?.(chatId) === true,
      );
    }
  }

  async #reconcileNativeHistoryStrictOnce(chatId: string): Promise<void> {
    await this.#nativeEvidenceLock.runExclusive(chatId, async () => {
      const cohort = this.captureCohort(chatId);
      const records = this.#currentCohortRecords(cohort);
      if (records.length === 0) return;
      await this.#scanNativeEvidence(cohort);
    });
  }

  async settleNativeCohort(cohort: PendingUserInputCohort): Promise<void> {
    await this.#nativeEvidenceLock.runExclusive(cohort.chatId, async () => {
      const records = this.#currentCohortRecords(cohort);
      if (records.length === 0) return;

      try {
        const nativeMessages = await this.#scanNativeEvidence(cohort);
        this.#settleCohort(cohort, nativeMessages, true);
      } catch {
        this.#settleCohort(
          cohort,
          nativeUserMessages(this.#messages.getRetainedHistoryMessages(cohort.chatId)),
          this.#messages.hasCompleteHistory?.(cohort.chatId) === true,
        );
      }
    });
  }

  settleRetainedCohort(cohort: PendingUserInputCohort): void {
    this.#settleCohort(
      cohort,
      nativeUserMessages(this.#messages.getRetainedHistoryMessages(cohort.chatId)),
      this.#messages.hasCompleteHistory?.(cohort.chatId) === true,
    );
  }

  async #scanNativeEvidence(
    cohort: PendingUserInputCohort,
  ): Promise<UserMessage[]> {
    return scanCurrentNativeUserEvidence({
      chatId: cohort.chatId,
      reader: this.#messages,
      shouldContinue: () => this.#currentCohortRecords(cohort).length > 0,
      acceptEvidence: (messages, includesNativeStart) => this.#clearMatches(
        cohort.chatId,
        this.#currentCohortRecords(cohort),
        messages,
        includesNativeStart,
      ),
    });
  }

  #reconcilableRecords(chatId: string): PendingUserInputRecord[] {
    return this.store
      .listRecordsForChat(chatId)
      .sort(byCreatedAt);
  }

  #currentCohortRecords(cohort: PendingUserInputCohort): PendingUserInputRecord[] {
    return cohort.records.filter((record) => this.store.isCurrentRecord(cohort.chatId, record));
  }

  #settleCohort(
    cohort: PendingUserInputCohort,
    messages: UserMessage[],
    includesNativeStart: boolean,
  ): void {
    this.#clearMatches(
      cohort.chatId,
      this.#currentCohortRecords(cohort),
      messages,
      includesNativeStart,
    );
    for (const record of this.#currentCohortRecords(cohort)) {
      if (record.deliveryStatus === 'failed') continue;
      if (this.store.updateDeliveryStatusIfCurrent(cohort.chatId, record, 'unconfirmed')) {
        logger.debug('pending input expired unmatched', {
          chatId: cohort.chatId,
          clientRequestId: record.clientRequestId,
          count: 1,
        });
      }
    }
  }

  #clearMatches(
    chatId: string,
    records: PendingUserInputRecord[],
    messages: UserMessage[],
    includesNativeStart: boolean,
  ): void {
    const exactRequestIds = matchingRequestIds(records, messages);
    for (const [recordIndex, record] of records.entries()) {
      const position = positionAfterOmittedFailedPredecessors(
        record,
        records.slice(0, recordIndex),
        exactRequestIds,
      );
      if (!position) continue;
      this.#nativeUserIdentities.bindPosition({
        chatId,
        messages,
        position,
        includesNativeStart,
        identity: {
          clientRequestId: record.clientRequestId,
          ...(record.clientMessageId ? { clientMessageId: record.clientMessageId } : {}),
          ...(record.turnId ? { turnId: record.turnId } : {}),
        },
      });
    }
    const identifiedMessages = this.#nativeUserIdentities.apply(chatId, messages);
    for (const clientRequestId of matchingRequestIds(records, identifiedMessages)) {
      this.store.clear(chatId, clientRequestId, 'persisted');
    }
  }
}

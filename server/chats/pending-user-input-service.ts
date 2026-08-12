import crypto from 'crypto';
import {
  type ChatImage,
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
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('pending-inputs');

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

export interface PendingUserInputCohort {
  readonly chatId: string;
  readonly records: readonly PendingUserInputRecord[];
}

interface NativeReconcileRun {
  dirty: boolean;
  promise: Promise<void>;
}

// Answers which client-request identities the projection has settled for a
// chat. Routine settlement clears on promotion to a durable ledger row; the
// stop-cohort path requires proven provider-native binding, so a promoted
// but unpersisted input on a stopped turn surfaces as unconfirmed.
export interface SettledInputRequestReader {
  settledInputRequests(chatId: string): Promise<ReadonlySet<string>>;
  nativelyBoundInputRequests(chatId: string): Promise<ReadonlySet<string>>;
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
  register(chatId: string, content: string, options?: RegisterPendingUserInputOptions): Promise<PendingUserInput>;
  captureCohort(chatId: string): PendingUserInputCohort;
  reconcileRetainedHistory(chatId: string): Promise<void>;
  reconcileNativeHistory(chatId: string): Promise<void>;
  settleNativeCohort(cohort: PendingUserInputCohort): Promise<void>;
}

// Settlement uses admission entry identity and source promotion: a record
// clears once the projection binds its client-request identity to proven
// provider-native evidence, and a stop-captured cohort that cannot prove
// persistence surfaces as unconfirmed instead of silently clearing. Native
// user-message text never participates.
export class PendingUserInputService implements PendingUserInputServiceContract {
  readonly store = new PendingUserInputStore();
  #settled: SettledInputRequestReader;
  #settleLock = new KeyedPromiseLock();
  #nativeReconcileByChatId = new Map<string, NativeReconcileRun>();

  constructor(settled: SettledInputRequestReader) {
    this.#settled = settled;
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

  // Registration never blocks on a settlement read; commit-driven reconciles
  // and snapshot reads clear records the projection has already proven.
  async register(chatId: string, content: string, options: RegisterPendingUserInputOptions = {}): Promise<PendingUserInput> {
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
    if (!this.store.hasRecordsForChat(chatId)) return;
    await this.#clearSettled(chatId, this.#reconcilableRecords(chatId));
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
      try {
        await this.#clearSettled(chatId, this.#reconcilableRecords(chatId));
      } catch (error) {
        logger.warn('pending input settlement read failed', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    } while (run.dirty && this.store.hasRecordsForChat(chatId));
  }

  async settleNativeCohort(cohort: PendingUserInputCohort): Promise<void> {
    await this.#settleLock.runExclusive(cohort.chatId, async () => {
      if (this.#currentCohortRecords(cohort).length === 0) return;
      try {
        await this.#clearSettled(cohort.chatId, this.#currentCohortRecords(cohort), true);
      } catch (error) {
        logger.warn('pending cohort settlement read failed', {
          chatId: cohort.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Whatever the boundary could not prove persisted is unconfirmed, never
      // silently cleared.
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
    });
  }

  async #clearSettled(
    chatId: string,
    records: readonly PendingUserInputRecord[],
    requireNativeBinding = false,
  ): Promise<void> {
    if (records.length === 0) return;
    const settled = requireNativeBinding
      ? await this.#settled.nativelyBoundInputRequests(chatId)
      : await this.#settled.settledInputRequests(chatId);
    for (const record of records) {
      if (!settled.has(record.clientRequestId)) continue;
      this.store.clear(chatId, record.clientRequestId, 'persisted');
    }
  }

  #reconcilableRecords(chatId: string): PendingUserInputRecord[] {
    return this.store
      .listRecordsForChat(chatId)
      .sort(byCreatedAt);
  }

  #currentCohortRecords(cohort: PendingUserInputCohort): PendingUserInputRecord[] {
    return cohort.records.filter((record) => this.store.isCurrentRecord(cohort.chatId, record));
  }
}

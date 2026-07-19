import type { PendingUserInputAttachment } from '../../common/pending-user-input.js';
import type { CommandLedger, CommandLedgerRecord } from '../commands/command-ledger.js';
import type { PendingUserInputService } from './pending-user-input-service.js';
import type { PendingUserInputImageEvidence } from './pending-user-input-store.js';
import type { ChatMessage } from '../../common/chat-types.js';

interface PendingUserInputRecoveryDeps {
  ledger: Pick<
    CommandLedger,
    'listPendingInputRecoveries' | 'settlePendingInputRecovery'
  >;
  pendingInputs: Pick<
    PendingUserInputService,
    'reconcileRestoredHistory' | 'restoreUnconfirmed' | 'store'
  >;
  nativeSnapshots?: {
    reconcileNativeSnapshot(chatId: string, messages: readonly ChatMessage[]): Promise<void>;
  };
  chatExists(chatId: string): boolean;
  onRecoveredChatSettled(chatId: string): Promise<void>;
}

export interface PendingUserInputRecoveryResult {
  restored: number;
  discardedMissingChat: number;
  restoredChatIds: string[];
}

export interface PendingUserInputRecoveryReconciliation {
  nativeSnapshotApplied: boolean;
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

function settlementRequestKey(chatId: string, clientRequestId: string): string {
  return JSON.stringify([chatId, clientRequestId]);
}

function attachmentPlaceholder(value: unknown): PendingUserInputAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  return {
    name: raw.name,
    ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
  };
}

function attachmentEvidence(value: unknown): PendingUserInputImageEvidence | null {
  const attachment = attachmentPlaceholder(value);
  if (!attachment || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.dataSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.dataSha256)
    || typeof raw.dataLength !== 'number'
    || !Number.isSafeInteger(raw.dataLength)
    || raw.dataLength < 0
  ) {
    return null;
  }
  return {
    ...attachment,
    dataSha256: raw.dataSha256,
    dataLength: raw.dataLength,
  };
}

function recoveryAttachments(record: CommandLedgerRecord): {
  attachments?: PendingUserInputAttachment[];
  imageEvidence?: PendingUserInputImageEvidence[];
} {
  if (!Array.isArray(record.payload.images) || record.payload.images.length === 0) return {};
  const attachments = record.payload.images.flatMap((value) => {
    const attachment = attachmentPlaceholder(value);
    return attachment ? [attachment] : [];
  });
  const evidence = record.payload.images.flatMap((value) => {
    const entry = attachmentEvidence(value);
    return entry ? [entry] : [];
  });
  return {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(evidence.length === record.payload.images.length ? { imageEvidence: evidence } : {}),
  };
}

export class PendingUserInputRecoveryCoordinator {
  #deps: PendingUserInputRecoveryDeps;
  #onSettlementError: (error: unknown) => void;
  #started = false;
  #settlementTasksByRequestKey = new Map<string, Promise<void>>();
  #unsettledRequestIdsByChatId = new Map<string, Set<string>>();
  #restoredRequestIdsByChatId = new Map<string, Set<string>>();
  #settledRecoveredChatIds = new Set<string>();
  #recoveredChatSettlementTasks = new Map<string, Promise<void>>();
  #recoveredChatSettlementActive = false;
  #reconciliationByChatId = new Map<string, Promise<PendingUserInputRecoveryReconciliation>>();
  #acceptingReconciliations = true;

  constructor(
    deps: PendingUserInputRecoveryDeps,
    onSettlementError: (error: unknown) => void = () => undefined,
  ) {
    this.#deps = deps;
    this.#onSettlementError = onSettlementError;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#deps.pendingInputs.store.onCleared((chatId, clientRequestId) => {
      const requestIds = this.#unsettledRequestIdsByChatId.get(chatId) ?? new Set<string>();
      requestIds.add(clientRequestId);
      this.#unsettledRequestIdsByChatId.set(chatId, requestIds);
      const task = this.#startSettlement(chatId, clientRequestId);
      void task.catch((error) => this.#reportSettlementError(error));
    });
  }

  async reconcileChat(chatId: string): Promise<PendingUserInputRecoveryReconciliation> {
    const existing = this.#reconciliationByChatId.get(chatId);
    if (existing) return existing;
    if (!this.#acceptingReconciliations) {
      throw new Error('Pending-input recovery is shutting down');
    }
    const task = (async () => {
      let nativeSnapshotApplied = false;
      const nativeSnapshots = this.#deps.nativeSnapshots;
      const reconciliation = await this.#deps.pendingInputs.reconcileRestoredHistory(
        chatId,
        nativeSnapshots
          ? async (messages) => {
            await nativeSnapshots.reconcileNativeSnapshot(chatId, messages);
            nativeSnapshotApplied = true;
          }
          : undefined,
      );
      const restoredRequestIds = this.#restoredRequestIdsByChatId.get(chatId);
      const unsettledRequestIds = this.#unsettledRequestIdsByChatId.get(chatId);
      const settlementRequestIds = new Set(reconciliation.clearedRequestIds);
      if (restoredRequestIds && unsettledRequestIds) {
        for (const clientRequestId of restoredRequestIds) {
          if (unsettledRequestIds.has(clientRequestId)) settlementRequestIds.add(clientRequestId);
        }
      }
      await this.#waitForRequestSettlements(chatId, [...settlementRequestIds]);
      return { nativeSnapshotApplied };
    })();
    this.#reconciliationByChatId.set(chatId, task);
    try {
      return await task;
    } finally {
      if (this.#reconciliationByChatId.get(chatId) === task) {
        this.#reconciliationByChatId.delete(chatId);
      }
    }
  }

  beginShutdown(): void {
    this.#acceptingReconciliations = false;
  }

  async waitForBackgroundTasks(): Promise<void> {
    this.beginShutdown();
    const errors: unknown[] = [];
    const attemptedSettlementKeys = new Set<string>();
    while (true) {
      const reconciliations = [...new Set(this.#reconciliationByChatId.values())];
      const settlementRequests = this.#unattemptedSettlementRequests(attemptedSettlementKeys);
      const recoveredChatSettlements = [...new Set(this.#recoveredChatSettlementTasks.values())];
      if (
        reconciliations.length === 0
        && settlementRequests.length === 0
        && recoveredChatSettlements.length === 0
      ) break;
      const results = await Promise.allSettled([
        ...reconciliations,
        ...settlementRequests.map(({ chatId, clientRequestId }) => (
          this.#startSettlement(chatId, clientRequestId)
        )),
        ...recoveredChatSettlements,
      ]);
      errors.push(...results.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      )));
    }
    throwCollectedErrors(errors, 'Pending-input recovery background work failed');
  }

  async waitForSettlements(chatId: string): Promise<void> {
    await this.#waitForRequestSettlements(
      chatId,
      [...(this.#unsettledRequestIdsByChatId.get(chatId) ?? [])],
    );
  }

  async restore(): Promise<PendingUserInputRecoveryResult> {
    const records = await this.#deps.ledger.listPendingInputRecoveries();
    let restored = 0;
    let discardedMissingChat = 0;
    const restoredChatIds = new Set<string>();

    for (const record of records) {
      if (!this.#deps.chatExists(record.chatId)) {
        await this.#deps.ledger.settlePendingInputRecovery(record.chatId, record.clientRequestId);
        discardedMissingChat += 1;
        continue;
      }
      const restoredRequestIds = this.#restoredRequestIdsByChatId.get(record.chatId)
        ?? new Set<string>();
      restoredRequestIds.add(record.clientRequestId);
      this.#restoredRequestIdsByChatId.set(record.chatId, restoredRequestIds);
      this.#deps.pendingInputs.restoreUnconfirmed({
        chatId: record.chatId,
        clientRequestId: record.clientRequestId,
        content: typeof record.payload.command === 'string'
          ? record.payload.command
          : typeof record.payload.content === 'string'
            ? record.payload.content
            : '',
        createdAt: record.acceptedAt,
        ...(typeof record.payload.clientMessageId === 'string'
          ? { clientMessageId: record.payload.clientMessageId }
          : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
        ...recoveryAttachments(record),
      });
      restored += 1;
      restoredChatIds.add(record.chatId);
    }

    return {
      restored,
      discardedMissingChat,
      restoredChatIds: [...restoredChatIds].sort(),
    };
  }

  async activateRecoveredChatSettlement(): Promise<void> {
    if (this.#recoveredChatSettlementActive) return;
    this.#recoveredChatSettlementActive = true;
    const tasks = [...this.#settledRecoveredChatIds].map((chatId) => (
      this.#startRecoveredChatSettlement(chatId)
    ));
    await Promise.all(tasks);
  }

  async #waitForRequestSettlements(
    chatId: string,
    clientRequestIds: readonly string[],
  ): Promise<void> {
    const unsettledRequestIds = this.#unsettledRequestIdsByChatId.get(chatId);
    if (!unsettledRequestIds) return;
    const results = await Promise.allSettled(clientRequestIds
      .filter((clientRequestId) => unsettledRequestIds.has(clientRequestId))
      .map((clientRequestId) => this.#startSettlement(chatId, clientRequestId)));
    throwCollectedErrors(
      results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      `Pending-input recovery settlement failed for ${chatId}`,
    );
  }

  #unattemptedSettlementRequests(
    attemptedRequestKeys: Set<string>,
  ): Array<{ chatId: string; clientRequestId: string }> {
    const requests = [...this.#unsettledRequestIdsByChatId]
      .flatMap(([chatId, requestIds]) => [...requestIds]
        .map((clientRequestId) => ({ chatId, clientRequestId })))
      .filter(({ chatId, clientRequestId }) => (
        !attemptedRequestKeys.has(settlementRequestKey(chatId, clientRequestId))
      ));
    for (const { chatId, clientRequestId } of requests) {
      attemptedRequestKeys.add(settlementRequestKey(chatId, clientRequestId));
    }
    return requests;
  }

  #startSettlement(chatId: string, clientRequestId: string): Promise<void> {
    const key = settlementRequestKey(chatId, clientRequestId);
    const existing = this.#settlementTasksByRequestKey.get(key);
    if (existing) return existing;
    const task = this.#deps.ledger.settlePendingInputRecovery(chatId, clientRequestId)
      .then(async () => {
        const requestIds = this.#unsettledRequestIdsByChatId.get(chatId);
        requestIds?.delete(clientRequestId);
        if (requestIds?.size === 0) this.#unsettledRequestIdsByChatId.delete(chatId);
        const restoredRequestIds = this.#restoredRequestIdsByChatId.get(chatId);
        restoredRequestIds?.delete(clientRequestId);
        if (restoredRequestIds?.size === 0) {
          this.#restoredRequestIdsByChatId.delete(chatId);
          await this.#queueRecoveredChatSettlement(chatId);
        }
      })
      .finally(() => {
        this.#settlementTasksByRequestKey.delete(key);
      });
    this.#settlementTasksByRequestKey.set(key, task);
    return task;
  }

  #queueRecoveredChatSettlement(chatId: string): Promise<void> {
    this.#settledRecoveredChatIds.add(chatId);
    if (!this.#recoveredChatSettlementActive) return Promise.resolve();
    return this.#startRecoveredChatSettlement(chatId);
  }

  #startRecoveredChatSettlement(chatId: string): Promise<void> {
    const existing = this.#recoveredChatSettlementTasks.get(chatId);
    if (existing) return existing;
    this.#settledRecoveredChatIds.delete(chatId);
    const task = this.#deps.onRecoveredChatSettled(chatId)
      .catch((error) => this.#reportSettlementError(error))
      .finally(() => {
        this.#recoveredChatSettlementTasks.delete(chatId);
      });
    this.#recoveredChatSettlementTasks.set(chatId, task);
    return task;
  }

  #reportSettlementError(error: unknown): void {
    try {
      this.#onSettlementError(error);
    } catch {
      // Settlement remains retryable even when diagnostic reporting fails.
    }
  }
}

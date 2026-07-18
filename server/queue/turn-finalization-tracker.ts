export type QueuedTurnFinalizationOutcome = 'committed' | 'not-committed';

interface QueuedTurnFinalizationRecord {
  readonly promise: Promise<QueuedTurnFinalizationOutcome>;
  resolve(outcome: QueuedTurnFinalizationOutcome): void;
  settled: boolean;
}

export interface QueuedTurnFinalizationHandle {
  settle(outcome: QueuedTurnFinalizationOutcome): void;
}

const MAX_RETAINED_FINALIZATIONS_PER_CHAT = 64;

export class QueuedTurnFinalizationTracker {
  readonly #recordsByChatId = new Map<string, Map<string, QueuedTurnFinalizationRecord>>();

  begin(chatId: string, executionAttemptId: string): QueuedTurnFinalizationHandle {
    const records = this.#recordsByChatId.get(chatId) ?? new Map<string, QueuedTurnFinalizationRecord>();
    const previous = records.get(executionAttemptId);
    if (previous && !previous.settled) {
      throw new Error(`Queued turn finalization already exists: ${chatId}/${executionAttemptId}`);
    }
    if (previous) records.delete(executionAttemptId);

    let resolvePromise!: (outcome: QueuedTurnFinalizationOutcome) => void;
    const record: QueuedTurnFinalizationRecord = {
      promise: new Promise((resolve) => {
        resolvePromise = resolve;
      }),
      resolve: resolvePromise,
      settled: false,
    };
    records.set(executionAttemptId, record);
    this.#recordsByChatId.set(chatId, records);
    this.#prune(records);

    return {
      settle(outcome) {
        if (record.settled) return;
        record.settled = true;
        record.resolve(outcome);
      },
    };
  }

  get(
    chatId: string,
    executionAttemptId: string | undefined,
  ): Promise<QueuedTurnFinalizationOutcome> | null {
    if (!executionAttemptId) return null;
    return this.#recordsByChatId.get(chatId)?.get(executionAttemptId)?.promise ?? null;
  }

  clearChat(chatId: string): void {
    const records = this.#recordsByChatId.get(chatId);
    if (!records) return;
    for (const record of records.values()) {
      if (!record.settled) {
        record.settled = true;
        record.resolve('not-committed');
      }
    }
    this.#recordsByChatId.delete(chatId);
  }

  #prune(records: Map<string, QueuedTurnFinalizationRecord>): void {
    while (records.size > MAX_RETAINED_FINALIZATIONS_PER_CHAT) {
      const oldest = records.entries().next().value as [string, QueuedTurnFinalizationRecord] | undefined;
      if (!oldest) return;
      const [turnId, record] = oldest;
      if (!record.settled) return;
      records.delete(turnId);
    }
  }
}

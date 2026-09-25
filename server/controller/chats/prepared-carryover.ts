import type { TranscriptViewId } from '../ledger/contracts.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { CarryOverOutcome } from './carryover-outcome.js';

export interface PreparedCarryover {
  readonly chatId: string;
  readonly transcriptViewId: TranscriptViewId;
  readonly targetAgentId: string;
  readonly targetExecutorId: string;
  readonly targetOwnershipEpoch: string;
  readonly clientRequestId: string;
  readonly result: CarryOverOutcome;
}

export class PreparedCarryoverStore {
  readonly #byChat = new Map<string, PreparedCarryover>();

  deposit(value: PreparedCarryover): void {
    this.#byChat.set(value.chatId, value);
  }

  take(input: {
    readonly chatId: string;
    readonly transcriptViewId: TranscriptViewId;
    readonly targetAgentId: string;
    readonly targetExecutorId: string;
    readonly targetOwnershipEpoch: string | undefined;
    readonly clientRequestId: string | null;
  }): CarryOverOutcome | null {
    const value = this.#byChat.get(input.chatId);
    this.#byChat.delete(input.chatId);
    if (
      !value
      || value.transcriptViewId !== input.transcriptViewId
      || value.targetAgentId !== input.targetAgentId
      || effectiveExecutorId(value.targetExecutorId) !== effectiveExecutorId(input.targetExecutorId)
      || value.targetOwnershipEpoch !== input.targetOwnershipEpoch
      || value.clientRequestId !== input.clientRequestId
    ) {
      return null;
    }
    return value.result;
  }

  discard(chatId: string): void {
    this.#byChat.delete(chatId);
  }
}

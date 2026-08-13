import {
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
  type StoredChatExecutionControlState,
} from './control-state.ts';

export interface ChatExecutionControlRepository {
  load(chatId: string): StoredChatExecutionControlState;
  save(chatId: string, control: StoredChatExecutionControlState): StoredChatExecutionControlState;
  delete(chatId: string): void;
}

export class InMemoryChatExecutionControlRepository implements ChatExecutionControlRepository {
  readonly #controlsByChatId = new Map<string, StoredChatExecutionControlState>();

  constructor(readonly serverInstanceId: string) {}

  load(chatId: string): StoredChatExecutionControlState {
    return cloneStoredChatExecutionControl(
      this.#controlsByChatId.get(chatId) ?? emptyStoredChatExecutionControl(this.serverInstanceId),
    );
  }

  save(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): StoredChatExecutionControlState {
    if (control.serverInstanceId !== this.serverInstanceId) {
      throw new Error('Cannot save execution controls from another server instance');
    }
    const saved = cloneStoredChatExecutionControl(control);
    this.#controlsByChatId.set(chatId, saved);
    return cloneStoredChatExecutionControl(saved);
  }

  delete(chatId: string): void {
    this.#controlsByChatId.delete(chatId);
  }
}

import {
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
  type StoredChatExecutionControlState,
} from './control-state.ts';

export interface ChatExecutionControlRepository {
  load(chatId: string): Promise<StoredChatExecutionControlState>;
  save(chatId: string, control: StoredChatExecutionControlState): Promise<StoredChatExecutionControlState>;
  delete(chatId: string): Promise<void>;
}

export class InMemoryChatExecutionControlRepository implements ChatExecutionControlRepository {
  readonly #controlsByChatId = new Map<string, StoredChatExecutionControlState>();

  async load(chatId: string): Promise<StoredChatExecutionControlState> {
    return cloneStoredChatExecutionControl(
      this.#controlsByChatId.get(chatId) ?? emptyStoredChatExecutionControl(),
    );
  }

  async save(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): Promise<StoredChatExecutionControlState> {
    const saved = cloneStoredChatExecutionControl(control);
    this.#controlsByChatId.set(chatId, saved);
    return cloneStoredChatExecutionControl(saved);
  }

  async delete(chatId: string): Promise<void> {
    this.#controlsByChatId.delete(chatId);
  }
}

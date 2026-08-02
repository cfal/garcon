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

  constructor(readonly serverInstanceId: string) {}

  async load(chatId: string): Promise<StoredChatExecutionControlState> {
    return cloneStoredChatExecutionControl(
      this.#controlsByChatId.get(chatId) ?? emptyStoredChatExecutionControl(this.serverInstanceId),
    );
  }

  async save(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): Promise<StoredChatExecutionControlState> {
    if (control.serverInstanceId !== this.serverInstanceId) {
      throw new Error('Cannot save execution controls from another server instance');
    }
    const saved = cloneStoredChatExecutionControl(control);
    this.#controlsByChatId.set(chatId, saved);
    return cloneStoredChatExecutionControl(saved);
  }

  async delete(chatId: string): Promise<void> {
    this.#controlsByChatId.delete(chatId);
  }
}

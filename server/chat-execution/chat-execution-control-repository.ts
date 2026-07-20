import { promises as fs } from 'fs';
import path from 'path';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import {
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
  normalizeStoredChatExecutionControlState,
  parseStoredChatExecutionControlState,
  storedChatExecutionControlNeedsCanonicalization,
  type StoredChatExecutionControlState,
} from './control-state.ts';

const QUEUE_FILE_SUFFIX = '.queue.json';

export interface StoredControlSnapshot {
  control: StoredChatExecutionControlState;
  needsCanonicalization: boolean;
}

export interface ChatExecutionControlRepository {
  load(chatId: string): Promise<StoredChatExecutionControlState>;
  loadFresh(chatId: string): Promise<StoredControlSnapshot>;
  save(chatId: string, control: StoredChatExecutionControlState): Promise<StoredChatExecutionControlState>;
  delete(chatId: string): Promise<void>;
  listStoredChatIds(): Promise<readonly string[]>;
}

export class JsonChatExecutionControlRepository implements ChatExecutionControlRepository {
  readonly #queuesDir: string;
  readonly #controlsByChatId = new Map<string, StoredChatExecutionControlState>();

  constructor(workspaceDir: string) {
    this.#queuesDir = path.join(workspaceDir, 'queues');
  }

  async load(chatId: string): Promise<StoredChatExecutionControlState> {
    const cached = this.#controlsByChatId.get(chatId);
    if (cached) return cloneStoredChatExecutionControl(cached);
    return (await this.loadFresh(chatId)).control;
  }

  async loadFresh(chatId: string): Promise<StoredControlSnapshot> {
    try {
      const raw = JSON.parse(await fs.readFile(this.#filePath(chatId), 'utf8'));
      const control = parseStoredChatExecutionControlState(raw);
      this.#controlsByChatId.set(chatId, control);
      return {
        control: cloneStoredChatExecutionControl(control),
        needsCanonicalization: storedChatExecutionControlNeedsCanonicalization(raw, control),
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const control = emptyStoredChatExecutionControl();
      this.#controlsByChatId.set(chatId, control);
      return { control: cloneStoredChatExecutionControl(control), needsCanonicalization: false };
    }
  }

  async save(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): Promise<StoredChatExecutionControlState> {
    const normalized = normalizeStoredChatExecutionControlState(control);
    await writeJsonFileAtomic(this.#filePath(chatId), normalized);
    this.#controlsByChatId.set(chatId, normalized);
    return cloneStoredChatExecutionControl(normalized);
  }

  async delete(chatId: string): Promise<void> {
    this.#controlsByChatId.delete(chatId);
    try {
      await fs.unlink(this.#filePath(chatId));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async listStoredChatIds(): Promise<readonly string[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.#queuesDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return files
      .filter((file) => file.endsWith(QUEUE_FILE_SUFFIX))
      .map((file) => file.slice(0, -QUEUE_FILE_SUFFIX.length));
  }

  #filePath(chatId: string): string {
    return path.join(this.#queuesDir, `${chatId}${QUEUE_FILE_SUFFIX}`);
  }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CHAT_BOARD_MAX_COUNT,
  CHAT_BOARDS_FILE_MAX_BYTES,
  isChatBoardId,
  normalizeChatBoard,
  normalizeChatBoardCatalog,
  type ChatBoard,
  type ChatBoardCatalog,
} from '../../common/chat-boards.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { ChatBoardCatalogCommittedUnknownError, ChatBoardDomainError } from './errors.js';

const CHAT_BOARDS_FILE_VERSION = 1;

interface ChatBoardsFile {
  readonly version: typeof CHAT_BOARDS_FILE_VERSION;
  revision: number;
  boards: ChatBoard[];
}

interface ChatBoardMutationCommit<T> {
  readonly result: T;
  readonly catalog: ChatBoardCatalog;
}

const encoder = new TextEncoder();

function emptyFile(): ChatBoardsFile {
  return { version: CHAT_BOARDS_FILE_VERSION, revision: 0, boards: [] };
}

function fileByteLength(file: ChatBoardsFile): number {
  return encoder.encode(`${JSON.stringify(file, null, 2)}\n`).byteLength;
}

function parseFile(value: unknown): ChatBoardsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('chat-boards.json must contain an object');
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== CHAT_BOARDS_FILE_VERSION
    || Object.keys(raw).some((key) => !['version', 'revision', 'boards'].includes(key))
  ) throw new Error('chat-boards.json is invalid');
  const catalog = normalizeChatBoardCatalog({ revision: raw.revision, boards: raw.boards });
  if (!catalog || JSON.stringify(catalog.boards) !== JSON.stringify(raw.boards)) {
    throw new Error('chat-boards.json contains a non-canonical catalog');
  }
  return { version: CHAT_BOARDS_FILE_VERSION, revision: catalog.revision, boards: [...catalog.boards] };
}

export class ChatBoardStore {
  readonly #filePath: string;
  readonly #writeFile: typeof writeJsonFileAtomic;
  readonly #lock = new KeyedPromiseLock();
  #file = emptyFile();
  #mutationFence: 'clear' | 'unknown-durability' = 'clear';

  constructor(
    workspaceDir: string,
    deps: { readonly writeFile?: typeof writeJsonFileAtomic } = {},
  ) {
    this.#filePath = path.join(workspaceDir, 'chat-boards.json');
    this.#writeFile = deps.writeFile ?? writeJsonFileAtomic;
  }

  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
      this.#file = emptyFile();
      this.#mutationFence = 'clear';
      return;
    }
    try {
      if (encoder.encode(raw).byteLength > CHAT_BOARDS_FILE_MAX_BYTES) {
        throw new Error('chat-boards.json exceeds the maximum file size');
      }
      this.#file = parseFile(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`Failed to load ${this.#filePath}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    this.#mutationFence = 'clear';
  }

  snapshot(): ChatBoardCatalog {
    return structuredClone({ revision: this.#file.revision, boards: this.#file.boards });
  }

  async withCatalogRevision<T>(
    expectedRevision: number,
    work: (catalog: ChatBoardCatalog) => Promise<T>,
  ): Promise<T> {
    return this.#lock.runExclusive('chat-boards', async () => {
      this.#assertReadable(expectedRevision);
      return work(this.snapshot());
    });
  }

  async createWithGeneratedId(
    name: string,
    expectedRevision: number,
    generate: () => string,
  ): Promise<ChatBoardMutationCommit<string>> {
    let createdId = '';
    return this.#mutate(expectedRevision, (draft) => {
      if (draft.boards.length >= CHAT_BOARD_MAX_COUNT) {
        throw new ChatBoardDomainError(
          'CHAT_BOARD_LIMIT_REACHED',
          `A maximum of ${CHAT_BOARD_MAX_COUNT} chat boards is allowed`,
          409,
        );
      }
      const id = generate();
      if (!isChatBoardId(id) || draft.boards.some((board) => board.id === id)) {
        throw new ChatBoardDomainError(
          'CHAT_BOARD_VALIDATION_FAILED',
          'Generated chat board ID is invalid or already in use',
          500,
        );
      }
      const board = normalizeChatBoard({ id, name, columns: [] });
      if (!board) throw this.#validationError();
      draft.boards.push(board);
      createdId = id;
    }, () => createdId);
  }

  async update(board: ChatBoard, expectedRevision: number): Promise<ChatBoardMutationCommit<void>> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.boards.findIndex((candidate) => candidate.id === board.id);
      if (index < 0) throw this.#notFound();
      const normalized = normalizeChatBoard(board);
      if (!normalized) throw this.#validationError();
      draft.boards[index] = normalized;
    }, () => undefined);
  }

  async remove(boardId: string, expectedRevision: number): Promise<ChatBoardMutationCommit<void>> {
    return this.#mutate(expectedRevision, (draft) => {
      const index = draft.boards.findIndex((board) => board.id === boardId);
      if (index < 0) throw this.#notFound();
      draft.boards.splice(index, 1);
    }, () => undefined);
  }

  async reorder(
    orderedBoardIds: readonly string[],
    expectedRevision: number,
  ): Promise<ChatBoardMutationCommit<void>> {
    return this.#mutate(expectedRevision, (draft) => {
      if (
        orderedBoardIds.length !== draft.boards.length
        || new Set(orderedBoardIds).size !== orderedBoardIds.length
      ) throw this.#validationError('Chat board order is invalid');
      const byId = new Map(draft.boards.map((board) => [board.id, board]));
      const ordered = orderedBoardIds.map((id) => byId.get(id));
      if (ordered.some((board) => board === undefined)) {
        throw this.#validationError('Chat board order is invalid');
      }
      draft.boards = ordered as ChatBoard[];
    }, () => undefined);
  }

  async #mutate<T>(
    expectedRevision: number,
    change: (draft: ChatBoardsFile) => void,
    result: () => T,
  ): Promise<ChatBoardMutationCommit<T>> {
    return this.#lock.runExclusive('chat-boards', async () => {
      this.#assertWritable(expectedRevision);
      const draft = structuredClone(this.#file);
      change(draft);
      this.#assertCatalog(draft);
      draft.revision += 1;
      if (fileByteLength(draft) > CHAT_BOARDS_FILE_MAX_BYTES) {
        throw this.#validationError('The chat board catalog would exceed the maximum file size');
      }
      try {
        await this.#write(draft);
      } catch (error) {
        if (error instanceof ChatBoardCatalogCommittedUnknownError) {
          this.#file = draft;
          this.#mutationFence = 'unknown-durability';
        }
        throw error;
      }
      this.#file = draft;
      return {
        result: result(),
        catalog: structuredClone({ revision: draft.revision, boards: draft.boards }),
      };
    });
  }

  #assertReadable(expectedRevision: number): void {
    if (this.#mutationFence === 'unknown-durability') {
      throw new ChatBoardDomainError(
        'CHAT_BOARD_CATALOG_SAVE_UNKNOWN',
        'The chat board catalog has an unconfirmed save; restart the server before further changes.',
        503,
      );
    }
    if (expectedRevision !== this.#file.revision) {
      throw new ChatBoardDomainError(
        'CHAT_BOARD_REVISION_CONFLICT',
        'Chat boards changed in another client; review the latest catalog',
        409,
        true,
        this.snapshot(),
      );
    }
  }

  #assertWritable(expectedRevision: number): void {
    this.#assertReadable(expectedRevision);
    if (this.#file.revision === Number.MAX_SAFE_INTEGER) {
      throw new ChatBoardDomainError(
        'CHAT_BOARD_REVISION_EXHAUSTED',
        'Chat board revision limit reached',
        503,
      );
    }
  }

  #assertCatalog(file: ChatBoardsFile): void {
    const catalog = normalizeChatBoardCatalog({ revision: file.revision, boards: file.boards });
    if (!catalog) throw this.#validationError();
  }

  async #write(file: ChatBoardsFile): Promise<void> {
    try {
      await this.#writeFile(this.#filePath, file, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        throw new ChatBoardCatalogCommittedUnknownError(error);
      }
      throw error;
    }
  }

  #validationError(message = 'Chat board is invalid'): ChatBoardDomainError {
    return new ChatBoardDomainError('CHAT_BOARD_VALIDATION_FAILED', message, 400);
  }

  #notFound(): ChatBoardDomainError {
    return new ChatBoardDomainError('CHAT_BOARD_NOT_FOUND', 'Chat board not found', 404);
  }
}

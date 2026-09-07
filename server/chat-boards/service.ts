import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  isChatBoardId,
  normalizeChatBoard,
  type ChatBoardCatalog,
  type ChatBoardInvalidationReason,
  type CreateChatBoardRequest,
  type DeleteChatBoardRequest,
  type ReorderChatBoardsRequest,
  type UpdateChatBoardRequest,
} from '../../common/chat-boards.js';
import { ChatBoardCatalogCommittedUnknownError, ChatBoardDomainError } from './errors.js';
import { ChatBoardStore } from './store.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('chat-boards');

interface ChatBoardServiceEvents {
  invalidated: [revision: number, reason: ChatBoardInvalidationReason];
}

export class ChatBoardService extends EventEmitter<ChatBoardServiceEvents> {
  constructor(private readonly deps: { readonly store: ChatBoardStore; readonly newId?: () => string }) {
    super();
  }

  snapshot(): ChatBoardCatalog {
    return this.deps.store.snapshot();
  }

  withCatalogRevision<T>(
    expectedRevision: number,
    work: (catalog: ChatBoardCatalog) => Promise<T>,
  ): Promise<T> {
    return this.deps.store.withCatalogRevision(expectedRevision, work);
  }

  async create(request: CreateChatBoardRequest): Promise<{ boardId: string; catalog: ChatBoardCatalog }> {
    const commit = await this.#mutate('created', () =>
      this.deps.store.createWithGeneratedId(
        request.name,
        request.expectedRevision,
        this.deps.newId ?? (() => crypto.randomUUID()),
      ));
    return { boardId: commit.result, catalog: commit.catalog };
  }

  async update(request: UpdateChatBoardRequest): Promise<ChatBoardCatalog> {
    const board = normalizeChatBoard(request.board);
    if (!board) throw this.#validationError();
    return (await this.#mutate(
      'updated',
      () => this.deps.store.update(board, request.expectedRevision),
    )).catalog;
  }

  async remove(request: DeleteChatBoardRequest): Promise<ChatBoardCatalog> {
    if (!isChatBoardId(request.boardId)) throw this.#validationError();
    return (await this.#mutate(
      'removed',
      () => this.deps.store.remove(request.boardId, request.expectedRevision),
    )).catalog;
  }

  async reorder(request: ReorderChatBoardsRequest): Promise<ChatBoardCatalog> {
    if (
      !Array.isArray(request.orderedBoardIds)
      || !request.orderedBoardIds.every(isChatBoardId)
      || new Set(request.orderedBoardIds).size !== request.orderedBoardIds.length
    ) throw this.#validationError();
    return (await this.#mutate(
      'reordered',
      () => this.deps.store.reorder(request.orderedBoardIds, request.expectedRevision),
    )).catalog;
  }

  async #mutate<T extends { readonly catalog: ChatBoardCatalog }>(
    reason: ChatBoardInvalidationReason,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work();
      this.#emitInvalidation(result.catalog.revision, reason);
      return result;
    } catch (error) {
      if (error instanceof ChatBoardCatalogCommittedUnknownError) {
        this.#emitInvalidation(this.snapshot().revision, reason);
        throw new ChatBoardDomainError(
          'CHAT_BOARD_CATALOG_SAVE_UNKNOWN',
          'The chat board catalog was saved, but its durability could not be confirmed.',
          503,
        );
      }
      throw error;
    }
  }

  #emitInvalidation(revision: number, reason: ChatBoardInvalidationReason): void {
    try {
      this.emit('invalidated', revision, reason);
    } catch (error) {
      logger.error('Chat board invalidation listener failed', { revision, reason, error });
    }
  }

  #validationError(): ChatBoardDomainError {
    return new ChatBoardDomainError('CHAT_BOARD_VALIDATION_FAILED', 'Chat board is invalid', 400);
  }
}

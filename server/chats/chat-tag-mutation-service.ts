import { isDeepStrictEqual } from 'node:util';
import {
  calculateChatTagTransition,
  chatMatchesBoardColumn,
  type ChatBoardCatalog,
} from '../../common/chat-boards.js';
import type {
  ApplyChatTagDeltaRequest,
  ChatTagsMutationResponse,
  RecoverChatTagsResponse,
  ReplaceChatTagsRequest,
  TransitionChatTagsRequest,
} from '../../common/chat-tag-mutations.js';
import { normalizeTags } from '../../common/tags.js';
import type { ChatBoardService } from '../chat-boards/service.js';
import { ChatBoardDomainError } from '../chat-boards/errors.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import {
  ChatRegistryDurabilityUnknownError,
  type ChatRegistryResolvedEntry,
  type IChatRegistry,
} from './store.js';

interface ChatArchiveStatePort {
  isArchived(chatId: string): boolean;
}

interface ChatTagMutationServiceDeps {
  readonly registry: Pick<
    IChatRegistry,
    'getChat' | 'chatMutationDurability' | 'updateChatPhased' | 'reconcileUnknownDurability'
  >;
  readonly chatMutationLock: Pick<KeyedPromiseLock, 'runExclusive'>;
  readonly boards: Pick<ChatBoardService, 'withCatalogRevision'>;
  readonly archiveState: ChatArchiveStatePort;
}

export class ChatTagMutationService {
  constructor(private readonly deps: ChatTagMutationServiceDeps) {}

  replace(input: ReplaceChatTagsRequest): Promise<ChatTagsMutationResponse> {
    return this.deps.chatMutationLock.runExclusive(`chat:${input.chatId}`, async () => {
      const current = this.#requireChat(input.chatId);
      this.#assertExpectedTags(current.tags, input.expectedTags);
      return this.#persistLocked(input.chatId, current.tags, normalizeTags(input.tags));
    });
  }

  applyDelta(input: ApplyChatTagDeltaRequest): Promise<ChatTagsMutationResponse> {
    return this.deps.chatMutationLock.runExclusive(`chat:${input.chatId}`, () =>
      this.applyDeltaWhileChatLocked(input));
  }

  async applyDeltaWhileChatLocked(
    input: ApplyChatTagDeltaRequest,
  ): Promise<ChatTagsMutationResponse> {
    const current = this.#requireChat(input.chatId);
    const removed = new Set(normalizeTags(input.removeTags ?? []));
    const nextTags = normalizeTags([
      ...current.tags.filter((tag) => !removed.has(tag)),
      ...normalizeTags(input.addTags ?? []),
    ]);
    return this.#persistLocked(input.chatId, current.tags, nextTags);
  }

  transition(input: TransitionChatTagsRequest): Promise<ChatTagsMutationResponse> {
    return this.deps.chatMutationLock.runExclusive(`chat:${input.chatId}`, async () => {
      try {
        return await this.deps.boards.withCatalogRevision(
          input.expectedCatalogRevision,
          async (catalog) => this.#transitionWithCatalog(input, catalog),
        );
      } catch (error) {
        if (
          error instanceof ChatBoardDomainError
          && error.code === 'CHAT_BOARD_REVISION_CONFLICT'
        ) {
          const current = this.#requireChat(input.chatId);
          throw new ChatBoardDomainError(
            error.code,
            error.message,
            error.status,
            error.retryable,
            error.catalog,
            current.tags,
          );
        }
        throw error;
      }
    });
  }

  recover(chatId: string): Promise<RecoverChatTagsResponse> {
    return this.deps.chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
      const result = await this.deps.registry.reconcileUnknownDurability(chatId);
      if (result === 'unavailable') throw this.#notFound();
      if (result === 'still-unknown') throw this.#saveUnknown(true);
      const current = this.#requireChat(chatId);
      return { success: true, chatId, tags: current.tags };
    });
  }

  async #transitionWithCatalog(
    input: TransitionChatTagsRequest,
    catalog: ChatBoardCatalog,
  ): Promise<ChatTagsMutationResponse> {
    const current = this.#requireChat(input.chatId);
    if (this.deps.archiveState.isArchived(input.chatId)) {
      throw new ChatBoardDomainError(
        'CHAT_BOARD_TRANSITION_CHAT_ARCHIVED',
        'Archived chats cannot be transitioned',
        409,
      );
    }
    try {
      this.#assertExpectedTags(current.tags, input.expectedTags);
    } catch (error) {
      if (error instanceof ChatBoardDomainError && error.code === 'CHAT_TAG_REVISION_CONFLICT') {
        throw new ChatBoardDomainError(
          error.code,
          error.message,
          error.status,
          error.retryable,
          catalog,
          current.tags,
        );
      }
      throw error;
    }
    if (input.sourceColumnId === input.targetColumnId) {
      throw this.#invalidTransition('Source and target columns must differ');
    }
    const board = catalog.boards.find((candidate) => candidate.id === input.boardId);
    if (!board) throw new ChatBoardDomainError('CHAT_BOARD_NOT_FOUND', 'Chat board not found', 404);
    const source = board.columns.find((column) => column.id === input.sourceColumnId);
    const target = board.columns.find((column) => column.id === input.targetColumnId);
    if (!source || !target) {
      throw new ChatBoardDomainError('CHAT_BOARD_NOT_FOUND', 'Chat board column not found', 404);
    }
    if (!chatMatchesBoardColumn(current.tags, source)) {
      throw this.#invalidTransition('Chat no longer matches the source column');
    }
    const appliedTargetTags = target.match === 'all'
      ? target.tags
      : this.#selectedAnyTags(target.tags, input.selectedTargetTags);
    const preview = calculateChatTagTransition({
      currentTags: current.tags,
      sourceTags: source.tags,
      appliedTargetTags,
    });
    if (isDeepStrictEqual(preview.resultingTags, current.tags)) {
      throw new ChatBoardDomainError(
        'CHAT_BOARD_TRANSITION_NOOP',
        'The transition would not change any tags',
        409,
      );
    }
    return this.#persistLocked(input.chatId, current.tags, preview.resultingTags);
  }

  #selectedAnyTags(
    targetTags: readonly string[],
    selectedTargetTags: readonly string[] | undefined,
  ): readonly string[] {
    if (!selectedTargetTags?.length) {
      throw this.#invalidTransition('At least one target tag must be selected');
    }
    const normalized = normalizeTags(selectedTargetTags);
    const exact = normalized.length === selectedTargetTags.length
      && normalized.every((tag, index) => tag === selectedTargetTags[index]);
    const allowed = new Set(targetTags);
    if (!exact || normalized.some((tag) => !allowed.has(tag))) {
      throw this.#invalidTransition('Selected tags must be a canonical subset of the target column');
    }
    return normalized;
  }

  #requireChat(chatId: string): ChatRegistryResolvedEntry {
    const durability = this.deps.registry.chatMutationDurability(chatId);
    if (durability === 'unavailable') throw this.#notFound();
    if (durability === 'unknown') throw this.#saveUnknown();
    const entry = this.deps.registry.getChat(chatId);
    if (!entry) throw this.#notFound();
    return { id: chatId, ...entry };
  }

  #assertExpectedTags(currentTags: readonly string[], expectedTags: readonly string[]): void {
    const normalized = normalizeTags(expectedTags);
    if (!isDeepStrictEqual(currentTags, normalized)) {
      throw new ChatBoardDomainError(
        'CHAT_TAG_REVISION_CONFLICT',
        'Chat tags changed in another client; review the latest tags',
        409,
        true,
        undefined,
        currentTags,
      );
    }
  }

  async #persistLocked(
    chatId: string,
    previousTags: readonly string[],
    nextTags: readonly string[],
  ): Promise<ChatTagsMutationResponse> {
    const tags = normalizeTags(nextTags);
    const before = new Set(previousTags);
    const after = new Set(tags);
    const addedTags = tags.filter((tag) => !before.has(tag));
    const removedTags = previousTags.filter((tag) => !after.has(tag));
    if (isDeepStrictEqual(previousTags, tags)) {
      return { success: true, chatId, tags, addedTags, removedTags };
    }
    try {
      const result = await this.deps.registry.updateChatPhased(chatId, { tags });
      if (!result) throw this.#notFound();
      if (result.durability === 'unknown') throw this.#saveUnknown();
      return {
        success: true,
        chatId,
        tags: result.entry.tags,
        addedTags,
        removedTags,
      };
    } catch (error) {
      if (error instanceof ChatRegistryDurabilityUnknownError) throw this.#saveUnknown();
      if (error instanceof ChatBoardDomainError) throw error;
      throw new ChatBoardDomainError(
        'CHAT_TAG_SAVE_FAILED',
        'Chat tags could not be saved',
        503,
        true,
      );
    }
  }

  #notFound(): ChatBoardDomainError {
    return new ChatBoardDomainError('SESSION_NOT_FOUND', 'Session not found', 404);
  }

  #saveUnknown(retryable = false): ChatBoardDomainError {
    return new ChatBoardDomainError(
      'CHAT_TAG_SAVE_UNKNOWN',
      'The tag save may have completed and must be confirmed before another change',
      503,
      retryable,
    );
  }

  #invalidTransition(message: string): ChatBoardDomainError {
    return new ChatBoardDomainError('CHAT_BOARD_TRANSITION_INVALID', message, 400);
  }
}

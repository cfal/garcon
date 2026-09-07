import type { ChatBoardCatalog } from '../../common/chat-boards.js';

export class ChatBoardDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly catalog?: ChatBoardCatalog,
    readonly currentTags?: readonly string[],
  ) {
    super(message);
    this.name = 'ChatBoardDomainError';
  }
}

export class ChatBoardCatalogCommittedUnknownError extends Error {
  constructor(cause: unknown) {
    super('The chat board catalog was committed, but its durability could not be confirmed.', {
      cause,
    });
    this.name = 'ChatBoardCatalogCommittedUnknownError';
  }
}

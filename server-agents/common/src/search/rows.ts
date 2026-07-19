import type { ChatSearchSnippetRole } from '@garcon/common/chat-search';

export interface SearchMessageRowInput {
  readonly role: ChatSearchSnippetRole;
  readonly timestamp: string | null;
  readonly body: string;
}

export interface HistoricalSearchMessageRow extends SearchMessageRowInput {
  readonly messageOrdinal: number;
}

export type ChatSearchSnippetRole = 'user' | 'assistant' | 'tool' | 'system';

export const CHAT_SEARCH_MAX_TERMS = 16;
export const CHAT_SEARCH_MAX_WORDS = 32;
export const CHAT_SEARCH_MIN_PREFIX_CHARS = 3;

export interface ChatSearchQueryV1 {
  readonly version: 1;
  readonly clauses: readonly ChatSearchClauseV1[];
}

export type ChatSearchClauseV1 =
  | { readonly kind: 'phrase'; readonly tokens: readonly ChatSearchTokenV1[] }
  | { readonly kind: 'all-words'; readonly tokens: readonly ChatSearchTokenV1[] };

export interface ChatSearchTokenV1 {
  readonly text: string;
  readonly normalized: string;
  readonly match: 'exact' | 'prefix';
}

export interface ChatSearchRequest {
  query: string;
  textTokens?: string[];
  chatIds?: string[];
  limit?: number;
}

export type TranscriptSearchEntryAnchor =
  | {
      readonly kind: 'carryover-entry';
      readonly segmentId: string;
      readonly localOrdinal: number;
    }
  | { readonly kind: 'agent-switch'; readonly segmentId: string }
  | {
      readonly kind: 'current-entry';
      readonly agentOwnershipEpoch: string;
      readonly entryId: string;
    };

export interface TranscriptSearchAllowedChat {
  readonly chatId: string;
  readonly contentEpoch: string;
}

export interface ChatSearchSnippet {
  messageOrdinal: number;
  anchor: TranscriptSearchEntryAnchor;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  text: string;
}

// Content-epoch-qualified navigation to one search snippet. The epoch names
// the composite lineage the ordinal is valid in; a stale result is rejected
// instead of scrolling to a possibly reused ordinal.
export interface ChatSearchNavigateRequest {
  readonly chatId: string;
  readonly contentEpoch: string;
  readonly messageOrdinal: number;
  readonly anchor: TranscriptSearchEntryAnchor;
}

export interface ChatSearchNavigateResponse {
  readonly chatId: string;
  readonly ordinal: number;
}

export interface ChatSearchResult {
  chatId: string;
  contentEpoch: string;
  score: number;
  matchedMessageCount: number;
  snippets: ChatSearchSnippet[];
}

export interface ChatSearchIndexStatus {
  indexedChatCount: number;
  pendingChatCount: number;
  failedChatCount: number;
  unsupportedChatCount: number;
}

export interface ChatSearchResponse {
  query: string;
  results: ChatSearchResult[];
  total: number;
  index: ChatSearchIndexStatus;
}

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

export interface TranscriptSearchAllowedChat {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly throughOrdinal: number;
}

export interface ChatSearchSnippet {
  ordinal: number;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  text: string;
}

export interface ChatSearchNavigateRequest {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

export interface ChatSearchNavigateResponse {
  readonly chatId: string;
  readonly ordinal: number;
}

export interface ChatSearchResult {
  chatId: string;
  transcriptViewId: string;
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

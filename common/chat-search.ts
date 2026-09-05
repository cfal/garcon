export type ChatSearchSnippetRole = 'user' | 'assistant' | 'tool' | 'system';

export const CHAT_SEARCH_MAX_TERMS = 16;
export const CHAT_SEARCH_MAX_WORDS = 32;
export const CHAT_SEARCH_MIN_PREFIX_CHARS = 3;
export const CHAT_SEARCH_MAX_PAGE_SIZE = 100;
export const CHAT_SEARCH_MAX_OFFSET = 9_999;
export const CHAT_SEARCH_SORT_VALUES = ['relevance', 'activity', 'created'] as const;

export type ChatSearchSort = (typeof CHAT_SEARCH_SORT_VALUES)[number];

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
  sort?: ChatSearchSort;
  offset?: number;
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
  unindexedChatCount: number;
  unsupportedChatCount: number;
  resultsTruncated: boolean;
}

export interface ChatSearchPage {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface ChatSearchResponse {
  query: string;
  results: ChatSearchResult[];
  page: ChatSearchPage;
  index: ChatSearchIndexStatus;
}

export type TranscriptSearchPhase =
  | 'disabled'
  | 'opening'
  | 'rebuilding'
  | 'ready'
  | 'degraded'
  | 'failed';

export interface TranscriptSearchStatusV1 {
  readonly version: 1;
  readonly phase: TranscriptSearchPhase;
  readonly chats: {
    readonly total: number;
    readonly indexed: number;
    readonly pending: number;
    readonly failed: number;
    readonly unindexed: number;
  };
  readonly queuedJobs: number;
  readonly resync: {
    readonly completedChats: number;
    readonly totalChats: number;
  } | null;
  readonly backlogRows: number;
  readonly activeChat: {
    readonly position: number;
    readonly total: number;
  } | null;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

export interface TranscriptSearchQueryStatsV1 {
  readonly served: number;
  readonly timedOut: number;
  readonly rejectedBusy: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export type TranscriptSearchStatusResponse = TranscriptSearchStatusV1 & {
  readonly queryStats: TranscriptSearchQueryStatsV1;
};

export function isTranscriptSearchStatusV1(value: unknown): value is TranscriptSearchStatusV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TranscriptSearchStatusV1>;
  const chats = candidate.chats;
  const resync = candidate.resync;
  const activeChat = candidate.activeChat;
  return !!chats
    && typeof chats === 'object'
    && candidate.version === 1
    && ['disabled', 'opening', 'rebuilding', 'ready', 'degraded', 'failed']
      .includes(candidate.phase as TranscriptSearchPhase)
    && [
      chats.indexed,
      chats.pending,
      chats.failed,
      chats.total,
      chats.unindexed,
      candidate.queuedJobs,
      candidate.backlogRows,
    ].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    && chats.indexed + chats.pending + chats.failed + chats.unindexed >= chats.total
    && (resync === null
      || (!!resync
        && typeof resync === 'object'
        && Number.isSafeInteger(resync.completedChats)
        && Number.isSafeInteger(resync.totalChats)
        && resync.completedChats >= 0
        && resync.totalChats >= resync.completedChats))
    && (activeChat === null
      || (!!activeChat
        && typeof activeChat === 'object'
        && Number.isSafeInteger(activeChat.position)
        && Number.isSafeInteger(activeChat.total)
        && activeChat.position >= 0
        && activeChat.total >= activeChat.position))
    && (candidate.lastErrorCode === null || typeof candidate.lastErrorCode === 'string')
    && typeof candidate.updatedAt === 'string';
}

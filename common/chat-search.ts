export type ChatSearchSnippetRole = 'user' | 'assistant' | 'tool' | 'system';

export const CHAT_SEARCH_MAX_TERMS = 16;
export const CHAT_SEARCH_MAX_WORDS = 32;
export const CHAT_SEARCH_MIN_PREFIX_CHARS = 3;
export const CHAT_SEARCH_DEFAULT_PAGE_SIZE = 20;
export const CHAT_SEARCH_MAX_PAGE_SIZE = 100;
export const CHAT_SEARCH_MAX_PREFIX_SIZE = 500;
export const CHAT_SEARCH_MAX_OFFSET = 9_999;
export const CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT = 3;
export const CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS = 520;
export const CHAT_SEARCH_MAX_CHAT_IDS = 10_000;
export const CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS = 20;
export const CHAT_SEARCH_SORT_VALUES = ['relevance', 'activity', 'created'] as const;
export const CHAT_SEARCH_RESULT_MODES = ['page', 'prefix'] as const;

export type ChatSearchSort = (typeof CHAT_SEARCH_SORT_VALUES)[number];
export type ChatSearchResultMode = (typeof CHAT_SEARCH_RESULT_MODES)[number];

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
  mode?: ChatSearchResultMode;
  offset?: number;
  limit?: number;
  snippetLimit?: number;
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
  failedChats: ChatSearchFailedChat[];
  failedChatsOmittedCount: number;
}

export type ChatSearchFailureStage = 'adoption' | 'ledger' | 'indexing';
export type ChatSearchFailureRecovery = 'source-required' | 'index-retry' | 'unknown';

export interface ChatSearchFailedChat {
  readonly chatId: string;
  readonly transcriptViewId: string | null;
  readonly stage: ChatSearchFailureStage;
  readonly errorCode: string;
  readonly indexedThroughOrdinal: number | null;
  readonly targetThroughOrdinal: number | null;
  readonly recovery: ChatSearchFailureRecovery;
}

const SOURCE_REQUIRED_SEARCH_FAILURES: ReadonlySet<string> = new Set([
  'CARRYOVER_HISTORY_UNAVAILABLE',
  'HISTORY_LOAD_FAILED',
  'LEDGER_FENCED',
  'SOURCE_TRANSCRIPT_UNAVAILABLE',
  'TRANSCRIPT_UNAVAILABLE',
]);

export function classifyChatSearchFailureRecovery(
  stage: ChatSearchFailureStage,
  errorCode: string,
): ChatSearchFailureRecovery {
  if (
    stage === 'adoption'
    || stage === 'ledger'
    || SOURCE_REQUIRED_SEARCH_FAILURES.has(errorCode)
    || errorCode.startsWith('SQLITE_')
  ) return 'source-required';
  if (stage === 'indexing' && errorCode.startsWith('SEARCH_')) return 'index-retry';
  return 'unknown';
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
  mode: ChatSearchResultMode;
  snippetLimit: number;
  results: ChatSearchResult[];
  page: ChatSearchPage;
  index: ChatSearchIndexStatus;
  removedStaleResultCount: number;
}

export function parseChatSearchResponse(
  request: ChatSearchRequest,
  value: unknown,
): ChatSearchResponse {
  const response = chatSearchRecord(value);
  if (!response || typeof response.query !== 'string') invalidChatSearchResponse('response');
  if (response.query !== request.query) invalidChatSearchResponse('query does not match request');
  const expectedMode = request.mode ?? 'page';
  const expectedSnippetLimit = request.snippetLimit ?? CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT;
  const expectedOffset = request.offset ?? 0;
  const expectedLimit = request.limit ?? CHAT_SEARCH_DEFAULT_PAGE_SIZE;
  if (response.mode !== expectedMode) invalidChatSearchResponse('mode does not match request');
  if (response.snippetLimit !== expectedSnippetLimit) {
    invalidChatSearchResponse('snippetLimit does not match request');
  }
  if (!Array.isArray(response.results)) invalidChatSearchResponse('results');
  const results = response.results.map((result) => parseChatSearchResult(
    result,
    expectedSnippetLimit,
  ));
  const page = chatSearchRecord(response.page);
  if (!page) invalidChatSearchResponse('page');
  const maximumLimit = expectedMode === 'prefix'
    ? CHAT_SEARCH_MAX_PREFIX_SIZE
    : CHAT_SEARCH_MAX_PAGE_SIZE;
  if (
    !isNonNegativeSafeInteger(page.offset)
    || page.offset > CHAT_SEARCH_MAX_OFFSET
    || page.offset !== expectedOffset
  ) invalidChatSearchResponse('offset does not match request');
  if (
    !isPositiveSafeInteger(page.limit)
    || page.limit > maximumLimit
    || page.limit !== expectedLimit
  ) invalidChatSearchResponse('limit does not match request');
  if (expectedMode === 'prefix' && (page.offset !== 0 || expectedSnippetLimit !== 1)) {
    invalidChatSearchResponse('prefix projection');
  }
  if (
    !isNonNegativeSafeInteger(page.total)
    || typeof page.hasMore !== 'boolean'
    || (page.nextOffset !== null && !isPositiveSafeInteger(page.nextOffset))
  ) invalidChatSearchResponse('page fields');
  if (page.hasMore !== (page.nextOffset !== null)) {
    invalidChatSearchResponse('cursor presence');
  }
  if (
    page.nextOffset !== null
    && (
      page.nextOffset <= page.offset
      || page.nextOffset > CHAT_SEARCH_MAX_OFFSET
      || page.nextOffset > page.offset + page.limit
      || page.nextOffset > page.total
    )
  ) invalidChatSearchResponse('cursor bounds');
  if (
    results.length > page.limit
    || results.length > Math.max(0, page.total - page.offset)
  ) invalidChatSearchResponse('result window');
  const index = parseChatSearchIndexStatus(response.index);
  if (
    !isNonNegativeSafeInteger(response.removedStaleResultCount)
    || results.length + response.removedStaleResultCount > page.limit
    || results.length + response.removedStaleResultCount > Math.max(0, page.total - page.offset)
  ) invalidChatSearchResponse('removed stale result count');
  return {
    query: response.query,
    mode: expectedMode,
    snippetLimit: expectedSnippetLimit,
    results,
    page: {
      offset: page.offset,
      limit: page.limit,
      total: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
    },
    index,
    removedStaleResultCount: response.removedStaleResultCount,
  };
}

export function compileChatSearchQuery(
  query: string,
  textTokens?: readonly string[],
): ChatSearchQueryV1 {
  const quoted = new Map<string, number>();
  for (const match of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const value = (match[1] ?? match[2] ?? '').toLowerCase();
    quoted.set(value, (quoted.get(value) ?? 0) + 1);
  }
  const terms = textTokens?.length
    ? textTokens.map((text) => {
      const key = text.toLowerCase();
      const count = quoted.get(key) ?? 0;
      if (count > 0) quoted.set(key, count - 1);
      return { text, phrase: /\s/u.test(text) || count > 0 };
    })
    : [...query.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((match) => ({
      text: match[1] ?? match[2] ?? match[3] ?? '',
      phrase: match[1] !== undefined || match[2] !== undefined,
    }));
  return {
    version: 1,
    clauses: terms.map((term) => ({
      kind: term.phrase ? 'phrase' as const : 'all-words' as const,
      tokens: (term.text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((text) => ({
        text,
        normalized: text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase(),
        match: !term.phrase && [...text].length >= CHAT_SEARCH_MIN_PREFIX_CHARS
          ? 'prefix' as const
          : 'exact' as const,
      })),
    })).filter((clause) => clause.tokens.length > 0),
  };
}

function parseChatSearchResult(value: unknown, snippetLimit: number): ChatSearchResult {
  const result = chatSearchRecord(value);
  if (
    !result
    || typeof result.chatId !== 'string'
    || result.chatId.length === 0
    || typeof result.transcriptViewId !== 'string'
    || result.transcriptViewId.length === 0
    || typeof result.score !== 'number'
    || !Number.isFinite(result.score)
    || !isNonNegativeSafeInteger(result.matchedMessageCount)
    || !Array.isArray(result.snippets)
    || result.snippets.length > snippetLimit
  ) invalidChatSearchResponse('result');
  const snippets = result.snippets.map((valueSnippet) => {
    const snippet = chatSearchRecord(valueSnippet);
    if (
      !snippet
      || !isPositiveSafeInteger(snippet.ordinal)
      || !['user', 'assistant', 'tool', 'system'].includes(String(snippet.role))
      || (snippet.timestamp !== null && typeof snippet.timestamp !== 'string')
      || typeof snippet.text !== 'string'
    ) invalidChatSearchResponse('snippet');
    return {
      ordinal: snippet.ordinal,
      role: snippet.role as ChatSearchSnippetRole,
      timestamp: snippet.timestamp,
      text: snippet.text,
    };
  });
  return {
    chatId: result.chatId,
    transcriptViewId: result.transcriptViewId,
    score: result.score,
    matchedMessageCount: result.matchedMessageCount,
    snippets,
  };
}

function parseChatSearchIndexStatus(value: unknown): ChatSearchIndexStatus {
  const index = chatSearchRecord(value);
  if (
    !index
    || !isNonNegativeSafeInteger(index.indexedChatCount)
    || !isNonNegativeSafeInteger(index.pendingChatCount)
    || !isNonNegativeSafeInteger(index.failedChatCount)
    || !isNonNegativeSafeInteger(index.unindexedChatCount)
    || !isNonNegativeSafeInteger(index.unsupportedChatCount)
    || typeof index.resultsTruncated !== 'boolean'
    || !Array.isArray(index.failedChats)
    || index.failedChats.length > CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS
    || !isNonNegativeSafeInteger(index.failedChatsOmittedCount)
  ) invalidChatSearchResponse('index');
  const failedChats = index.failedChats.map(parseFailedChat);
  if (
    new Set(failedChats.map((failure) => failure.chatId)).size !== failedChats.length
    || failedChats.length + index.failedChatsOmittedCount !== index.failedChatCount
  ) invalidChatSearchResponse('failed chat details');
  return {
    indexedChatCount: index.indexedChatCount,
    pendingChatCount: index.pendingChatCount,
    failedChatCount: index.failedChatCount,
    unindexedChatCount: index.unindexedChatCount,
    unsupportedChatCount: index.unsupportedChatCount,
    resultsTruncated: index.resultsTruncated,
    failedChats,
    failedChatsOmittedCount: index.failedChatsOmittedCount,
  };
}

function parseFailedChat(value: unknown): ChatSearchFailedChat {
  const failure = chatSearchRecord(value);
  if (
    !failure
    || typeof failure.chatId !== 'string'
    || !/^\d{16}$/u.test(failure.chatId)
    || (failure.transcriptViewId !== null && (
      typeof failure.transcriptViewId !== 'string'
      || failure.transcriptViewId.length === 0
      || failure.transcriptViewId.length > 512
    ))
    || !['adoption', 'ledger', 'indexing'].includes(String(failure.stage))
    || typeof failure.errorCode !== 'string'
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(failure.errorCode)
    || !nullableNonNegativeSafeInteger(failure.indexedThroughOrdinal)
    || !nullableNonNegativeSafeInteger(failure.targetThroughOrdinal)
    || (failure.indexedThroughOrdinal !== null
      && failure.targetThroughOrdinal !== null
      && failure.indexedThroughOrdinal > failure.targetThroughOrdinal)
    || !['source-required', 'index-retry', 'unknown'].includes(String(failure.recovery))
  ) invalidChatSearchResponse('failed chat detail');
  return {
    chatId: failure.chatId,
    transcriptViewId: failure.transcriptViewId as string | null,
    stage: failure.stage as ChatSearchFailureStage,
    errorCode: failure.errorCode,
    indexedThroughOrdinal: failure.indexedThroughOrdinal as number | null,
    targetThroughOrdinal: failure.targetThroughOrdinal as number | null,
    recovery: failure.recovery as ChatSearchFailureRecovery,
  };
}

function chatSearchRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function invalidChatSearchResponse(reason: string): never {
  throw new Error(`Invalid chat search response: ${reason}`);
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
  readonly admissionP50Ms: number;
  readonly admissionP95Ms: number;
  readonly admissionMaxMs: number;
  readonly totalP50Ms: number;
  readonly totalP95Ms: number;
  readonly totalMaxMs: number;
}

export type TranscriptSearchStatusResponse = TranscriptSearchStatusV1 & {
  readonly queryStats: TranscriptSearchQueryStatsV1;
};

export interface TranscriptSearchRebuildResponse {
  readonly success: true;
  readonly status: TranscriptSearchStatusResponse;
}

const TRANSCRIPT_SEARCH_STATUS_KEYS = [
  'version',
  'phase',
  'chats',
  'queuedJobs',
  'resync',
  'backlogRows',
  'activeChat',
  'lastErrorCode',
  'updatedAt',
] as const;

const TRANSCRIPT_SEARCH_CHAT_KEYS = [
  'total',
  'indexed',
  'pending',
  'failed',
  'unindexed',
] as const;

const TRANSCRIPT_SEARCH_PHASES: readonly TranscriptSearchPhase[] = [
  'disabled',
  'opening',
  'rebuilding',
  'ready',
  'degraded',
  'failed',
];

const TRANSCRIPT_SEARCH_QUERY_STAT_KEYS = [
  'served',
  'timedOut',
  'rejectedBusy',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'admissionP50Ms',
  'admissionP95Ms',
  'admissionMaxMs',
  'totalP50Ms',
  'totalP95Ms',
  'totalMaxMs',
] as const;

export function parseTranscriptSearchStatusResponse(
  value: unknown,
): TranscriptSearchStatusResponse {
  const response = chatSearchRecord(value);
  if (!response || !hasExactChatSearchKeys(response, [
    ...TRANSCRIPT_SEARCH_STATUS_KEYS,
    'queryStats',
  ])) {
    throw new Error('Invalid transcript search status response: unexpected fields');
  }
  const { queryStats: rawQueryStats, ...rawStatus } = response;
  if (!isTranscriptSearchStatusV1(rawStatus)) {
    throw new Error('Invalid transcript search status response: invalid status');
  }
  if (!isTranscriptSearchQueryStatsV1(rawQueryStats)) {
    throw new Error('Invalid transcript search status response: invalid query statistics');
  }
  return {
    ...rawStatus,
    queryStats: rawQueryStats,
  };
}

export function parseTranscriptSearchRebuildResponse(
  value: unknown,
): TranscriptSearchRebuildResponse {
  const response = chatSearchRecord(value);
  if (!response || !hasExactChatSearchKeys(response, ['success', 'status'])) {
    throw new Error('Invalid transcript search rebuild response: unexpected fields');
  }
  if (response.success !== true) {
    throw new Error('Invalid transcript search rebuild response: rebuild was not accepted');
  }
  let status: TranscriptSearchStatusResponse;
  try {
    status = parseTranscriptSearchStatusResponse(response.status);
  } catch (error) {
    throw new Error('Invalid transcript search rebuild response: invalid status', { cause: error });
  }
  return {
    success: true,
    status,
  };
}

function isTranscriptSearchQueryStatsV1(
  value: unknown,
): value is TranscriptSearchQueryStatsV1 {
  const queryStats = chatSearchRecord(value);
  return queryStats !== null
    && hasExactChatSearchKeys(queryStats, TRANSCRIPT_SEARCH_QUERY_STAT_KEYS)
    && TRANSCRIPT_SEARCH_QUERY_STAT_KEYS.every(
      (key) => isNonNegativeSafeInteger(queryStats[key]),
    );
}

export function isTranscriptSearchStatusV1(value: unknown): value is TranscriptSearchStatusV1 {
  const raw = chatSearchRecord(value);
  if (!raw || !hasExactChatSearchKeys(raw, TRANSCRIPT_SEARCH_STATUS_KEYS)) return false;
  return raw.version === 1
    && isTranscriptSearchPhase(raw.phase)
    && isTranscriptSearchChatCounts(raw.chats)
    && isNonNegativeSafeInteger(raw.queuedJobs)
    && isNonNegativeSafeInteger(raw.backlogRows)
    && isTranscriptSearchResync(raw.resync)
    && isTranscriptSearchActiveChat(raw.activeChat)
    && isTranscriptSearchErrorCode(raw.lastErrorCode)
    && isCanonicalChatSearchTimestamp(raw.updatedAt);
}

function isTranscriptSearchPhase(value: unknown): value is TranscriptSearchPhase {
  return typeof value === 'string'
    && TRANSCRIPT_SEARCH_PHASES.includes(value as TranscriptSearchPhase);
}

function isTranscriptSearchChatCounts(
  value: unknown,
): value is TranscriptSearchStatusV1['chats'] {
  const chats = chatSearchRecord(value);
  if (!chats || !hasExactChatSearchKeys(chats, TRANSCRIPT_SEARCH_CHAT_KEYS)) return false;
  if (
    !isNonNegativeSafeInteger(chats.total)
    || !isNonNegativeSafeInteger(chats.indexed)
    || !isNonNegativeSafeInteger(chats.pending)
    || !isNonNegativeSafeInteger(chats.failed)
    || !isNonNegativeSafeInteger(chats.unindexed)
  ) {
    return false;
  }
  return chats.indexed + chats.pending + chats.failed + chats.unindexed >= chats.total;
}

function isTranscriptSearchResync(
  value: unknown,
): value is TranscriptSearchStatusV1['resync'] {
  if (value === null) return true;
  const progress = chatSearchRecord(value);
  return progress !== null
    && hasExactChatSearchKeys(progress, ['completedChats', 'totalChats'])
    && isNonNegativeSafeInteger(progress.completedChats)
    && isNonNegativeSafeInteger(progress.totalChats)
    && progress.totalChats >= progress.completedChats;
}

function isTranscriptSearchActiveChat(
  value: unknown,
): value is TranscriptSearchStatusV1['activeChat'] {
  if (value === null) return true;
  const progress = chatSearchRecord(value);
  return progress !== null
    && hasExactChatSearchKeys(progress, ['position', 'total'])
    && isNonNegativeSafeInteger(progress.position)
    && isNonNegativeSafeInteger(progress.total)
    && progress.total >= progress.position;
}

function isTranscriptSearchErrorCode(value: unknown): value is string | null {
  return value === null
    || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value));
}

function hasExactChatSearchKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalChatSearchTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

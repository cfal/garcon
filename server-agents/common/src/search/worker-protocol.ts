import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
  CHAT_SEARCH_MIN_PREFIX_CHARS,
} from '@garcon/common/chat-search';
import type { HistoricalSearchMessageRow } from './rows.js';
import type {
  PrunedChatCleanup,
  SearchChatState,
} from './schema.js';

export type { PrunedChatCleanup, SearchChatState } from './schema.js';
export {
  SEARCH_INDEXER_CACHE_SIZE_PAGES,
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_TERM_STEP_MAX_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
} from './schema.js';

export const SEARCH_WORKER_MAX_ENVELOPE_BYTES = 1_048_576;
export const SEARCH_WORKER_STEP_START_TIMEOUT_MS = 30_000;
export const SEARCH_WORKER_PHYSICAL_STEP_TIMEOUT_MS = 30_000;
export const SEARCH_READER_MAX_ALLOWLIST_ROWS = 2_000;

export interface RequestIdentity {
  readonly requestId: number;
  readonly lifecycleEpoch: string;
}

export interface PhysicalGrantIdentity extends RequestIdentity {
  readonly grantId: number;
}

export interface WalObservation {
  readonly walEpoch: number;
  readonly walObservationSequence: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

export const INDEXER_WAL_AUTHORITATIVE_ERROR_CODES = [
  'INVALID_SEARCH_ERROR_CODE',
  'SEARCH_ACTIVATION_INVALID',
  'SEARCH_CHECKPOINT_STATE_INVALID',
  'SEARCH_CLEANUP_INVALID',
  'SEARCH_FRONTIER_INVALID',
  'SEARCH_IDENTIFIER_INVALID',
  'SEARCH_INDEX_CORRUPT',
  'SEARCH_INDEX_GAP',
  'SEARCH_POSTING_INVALID',
  'SEARCH_PRUNE_INVALID',
  'SEARCH_RAW_STAGE_INVALID',
  'SEARCH_STATE_INVARIANT',
  'SEARCH_TERM_BUILD_INVALID',
  'SEARCH_TOKENIZER_CLEANUP',
  'SEARCH_TOKENIZER_CLOSED',
  'SEARCH_TOKENIZER_CONFIGURATION',
  'SEARCH_TOKENIZER_DISK_PATH',
  'SEARCH_TOKENIZER_INVALID',
  'SEARCH_TOKENIZER_LIMIT',
  'SEARCH_VIEW_MISMATCH',
  'SEARCH_WAL_MAINTENANCE_REQUIRED',
  'SEARCH_WAL_OBSERVATION_INVALID',
] as const;

export type IndexerWalAuthoritativeErrorCode =
  (typeof INDEXER_WAL_AUTHORITATIVE_ERROR_CODES)[number];

const INDEXER_WAL_AUTHORITATIVE_ERRORS = new Set<string>(
  INDEXER_WAL_AUTHORITATIVE_ERROR_CODES,
);

export function isIndexerWalAuthoritativeErrorCode(
  value: unknown,
): value is IndexerWalAuthoritativeErrorCode {
  return typeof value === 'string' && INDEXER_WAL_AUTHORITATIVE_ERRORS.has(value);
}

export const INDEXER_RECORDABLE_BUILD_ERROR_CODES = [
  'SEARCH_TOKENIZER_INVALID',
  'SEARCH_TOKENIZER_LIMIT',
  'SEARCH_POSTING_INVALID',
] as const;

export type IndexerRecordableBuildErrorCode =
  (typeof INDEXER_RECORDABLE_BUILD_ERROR_CODES)[number];

const INDEXER_RECORDABLE_BUILD_ERRORS = new Set<string>(
  INDEXER_RECORDABLE_BUILD_ERROR_CODES,
);

export function isIndexerRecordableBuildErrorCode(
  value: unknown,
): value is IndexerRecordableBuildErrorCode {
  return typeof value === 'string' && INDEXER_RECORDABLE_BUILD_ERRORS.has(value);
}

export type IndexerPhysicalStep =
  | {
      readonly kind: 'plan-replacement';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly targetThrough: number;
    }
  | {
      readonly kind: 'plan-append';
      readonly chatId: string;
      readonly transcriptViewId: string;
      readonly expectedAfterOrdinal: number;
      readonly targetThrough: number;
    }
  | {
      readonly kind: 'stage-raw';
      readonly expectedState: SearchChatState;
      readonly rows: readonly HistoricalSearchMessageRow[];
    }
  | {
      readonly kind: 'build-terms';
      readonly expectedState: SearchChatState;
    }
  | {
      readonly kind: 'advance-frontier';
      readonly expectedState: SearchChatState;
      readonly throughOrdinal: number;
    }
  | {
      readonly kind: 'activate';
      readonly expectedState: SearchChatState;
    }
  | { readonly kind: 'start-removal'; readonly chatId: string }
  | { readonly kind: 'cleanup'; readonly expectedState: SearchChatState }
  | {
      readonly kind: 'complete-replacement-checkpoint';
      readonly expectedState: SearchChatState;
    }
  | {
      readonly kind: 'mark-failed';
      readonly expectedState: SearchChatState;
      readonly errorCode: string;
    }
  | {
      readonly kind: 'prune-mark';
      readonly allowedChatIds: readonly string[];
      readonly afterChatId: string | null;
    };

export type PhysicalStepResult =
  | {
      readonly kind: 'sync-plan';
      readonly disposition: 'current';
      readonly completion: 'terminal';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'sync-plan';
      readonly disposition: 'build' | 'cleanup';
      readonly completion: 'continue';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'sync-plan';
      readonly disposition: 'checkpoint';
      readonly completion: 'terminal';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'raw-staged';
      readonly completion: 'continue';
      readonly state: SearchChatState;
      readonly acceptedRows: number;
    }
  | {
      readonly kind: 'term-progress';
      readonly completion: 'continue';
      readonly state: SearchChatState;
      readonly insertedTerms: number;
      readonly insertedOccurrences: number;
      readonly completedChunk: boolean;
    }
  | {
      readonly kind: 'frontier-progress';
      readonly completion: 'continue';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'indexed';
      readonly completion: 'terminal';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'cleanup-progress';
      readonly completion: 'continue';
      readonly state: SearchChatState;
      readonly deletedTerms: number;
      readonly deletedRows: number;
      readonly deletedBodyBytes: number;
    }
  | {
      readonly kind: 'replacement-checkpoint';
      readonly completion: 'terminal';
      readonly state: SearchChatState;
    }
  | {
      readonly kind: 'chat-deleted';
      readonly completion: 'terminal';
      readonly chatId: string;
    }
  | {
      readonly kind: 'failure-recorded';
      readonly completion: 'terminal';
      readonly applied: boolean;
    }
  | {
      readonly kind: 'prune-progress';
      readonly completion: 'continue' | 'terminal';
      readonly cleanups: readonly PrunedChatCleanup[];
      readonly nextAfterChatId: string | null;
      readonly done: boolean;
    }
  | {
      readonly kind: 'mutation-superseded';
      readonly completion: 'terminal';
      readonly chatId: string;
    };

export type IndexerRequest =
  | (RequestIdentity & {
      readonly type: 'open';
      readonly dbPath: string;
      readonly walEpoch: number;
    })
  | (PhysicalGrantIdentity & {
      readonly type: 'physical-step-grant';
      readonly walEpoch: number;
      readonly step: IndexerPhysicalStep;
    })
  | (RequestIdentity & { readonly type: 'indexer-quiesce' })
  | (RequestIdentity & {
      readonly type: 'checkpoint';
      readonly mode: 'TRUNCATE';
      readonly walEpoch: number;
    });

export type IndexerEvent =
  | (RequestIdentity & { readonly type: 'opened'; readonly wal: WalObservation })
  | (PhysicalGrantIdentity & { readonly type: 'step-started' })
  | (PhysicalGrantIdentity & {
      readonly type: 'physical-step-complete';
      readonly result: PhysicalStepResult;
      readonly wal?: WalObservation;
    })
  | (RequestIdentity & { readonly type: 'indexer-quiesced' })
  | (RequestIdentity & {
      readonly type: 'checkpoint-complete';
      readonly busy: number;
      readonly logFrames: number;
      readonly checkpointedFrames: number;
      readonly wal: WalObservation;
    })
  | (RequestIdentity & {
      readonly type: 'error';
      readonly grantId: number | null;
      readonly code: string;
      readonly retryable: boolean;
      readonly wal?: WalObservation;
    });

export type ReaderRequest =
  | (RequestIdentity & { readonly type: 'open'; readonly dbPath: string })
  | (RequestIdentity & {
      readonly type: 'search-start';
      readonly query: ChatSearchQueryV1;
      readonly limit: number;
    })
  | (RequestIdentity & {
      readonly type: 'search-allowlist-chunk';
      readonly chunkIndex: number;
      readonly allowedChats: readonly TranscriptSearchAllowedChat[];
      readonly done: boolean;
    })
  | (PhysicalGrantIdentity & { readonly type: 'reader-step-grant' })
  | (RequestIdentity & { readonly type: 'reader-quiesce' });

export type ReaderStepResult =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'result-chunk';
      readonly chunkIndex: number;
      readonly results: readonly ChatSearchResult[];
      readonly done: false;
    }
  | {
      readonly kind: 'result-chunk';
      readonly chunkIndex: number;
      readonly results: readonly ChatSearchResult[];
      readonly index: ChatSearchIndexStatus;
      readonly done: true;
    };

export type ReaderEvent =
  | (RequestIdentity & { readonly type: 'opened' })
  | (RequestIdentity & {
      readonly type: 'search-input-ack';
      readonly chunkIndex: number | null;
      readonly ready: boolean;
    })
  | (PhysicalGrantIdentity & {
      readonly type: 'reader-step-complete';
      readonly result: ReaderStepResult;
    })
  | (RequestIdentity & { readonly type: 'reader-quiesced' })
  | (RequestIdentity & {
      readonly type: 'error';
      readonly grantId: number | null;
      readonly code: string;
      readonly retryable: boolean;
    });

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function exactKeys(candidate: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedText(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && hasWellFormedUtf16(value)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function identifier(value: unknown): value is string {
  return boundedText(value, 256);
}

function failureCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

export function workerEnvelopeBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      ? Buffer.byteLength(serialized, 'utf8')
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function workerEnvelopeWithinLimit(value: unknown): boolean {
  return workerEnvelopeBytes(value) <= SEARCH_WORKER_MAX_ENVELOPE_BYTES;
}

function requestIdentity(value: unknown): UnknownRecord | null {
  const candidate = record(value);
  return candidate
    && positiveSafeInteger(candidate.requestId)
    && identifier(candidate.lifecycleEpoch)
    && typeof candidate.type === 'string'
    ? candidate
    : null;
}

function grantIdentity(candidate: UnknownRecord): boolean {
  return positiveSafeInteger(candidate.grantId);
}

export function isWalObservation(value: unknown): value is WalObservation {
  const candidate = record(value);
  return Boolean(candidate)
    && exactKeys(candidate!, [
      'walEpoch',
      'walObservationSequence',
      'logFrames',
      'checkpointedFrames',
    ])
    && positiveSafeInteger(candidate!.walEpoch)
    && positiveSafeInteger(candidate!.walObservationSequence)
    && nonNegativeSafeInteger(candidate!.logFrames)
    && nonNegativeSafeInteger(candidate!.checkpointedFrames)
    && Number(candidate!.checkpointedFrames) <= Number(candidate!.logFrames);
}

export function isNewerWalObservation(
  candidate: WalObservation,
  current: WalObservation | null,
): boolean {
  return current === null
    || candidate.walEpoch > current.walEpoch
    || (candidate.walEpoch === current.walEpoch
      && candidate.walObservationSequence > current.walObservationSequence);
}

function searchState(value: unknown): value is SearchChatState {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, [
    'chatId',
    'transcriptViewId',
    'status',
    'phase',
    'targetThrough',
    'processedThrough',
    'activeChunkId',
    'slotDocumentCount',
    'slotTokenCount',
    'lastErrorCode',
    'updatedAt',
  ])
      || !identifier(candidate.chatId)
      || !identifier(candidate.transcriptViewId)
      || !['pending', 'indexed', 'failed'].includes(String(candidate.status))
      || ![
        'idle',
        'append-build',
        'replacement-cleanup',
        'replacement-checkpoint',
        'replacement-build',
        'removal-cleanup',
      ].includes(String(candidate.phase))
      || !nonNegativeSafeInteger(candidate.targetThrough)
      || !nonNegativeSafeInteger(candidate.processedThrough)
      || Number(candidate.processedThrough) > Number(candidate.targetThrough)
      || !(candidate.activeChunkId === null || positiveSafeInteger(candidate.activeChunkId))
      || !nonNegativeSafeInteger(candidate.slotDocumentCount)
      || !nonNegativeSafeInteger(candidate.slotTokenCount)
      || Number(candidate.slotTokenCount) < Number(candidate.slotDocumentCount)
      || !(candidate.lastErrorCode === null || failureCode(candidate.lastErrorCode))
      || !boundedText(candidate.updatedAt, 64)) return false;
  const indexed = candidate.status === 'indexed'
    && candidate.phase === 'idle'
    && candidate.processedThrough === candidate.targetThrough
    && candidate.activeChunkId === null
    && candidate.lastErrorCode === null;
  const pending = candidate.status === 'pending'
    && candidate.phase !== 'idle'
    && candidate.lastErrorCode === null;
  const failed = candidate.status === 'failed'
    && ['append-build', 'replacement-build'].includes(String(candidate.phase))
    && failureCode(candidate.lastErrorCode);
  return (indexed || pending || failed)
    && (candidate.phase !== 'replacement-checkpoint'
      || (candidate.activeChunkId === null
        && candidate.slotDocumentCount === 0
        && candidate.slotTokenCount === 0));
}

function searchRow(value: unknown): value is HistoricalSearchMessageRow {
  const candidate = record(value);
  return Boolean(candidate)
    && exactKeys(candidate!, ['ordinal', 'role', 'timestamp', 'body'])
    && positiveSafeInteger(candidate!.ordinal)
    && ['user', 'assistant', 'tool', 'system'].includes(String(candidate!.role))
    && (candidate!.timestamp === null || boundedText(candidate!.timestamp, 256))
    && boundedText(candidate!.body, 1_048_576)
    && String(candidate!.body).length <= 64_000;
}

function rows(value: unknown): value is readonly HistoricalSearchMessageRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16
      || !value.every(searchRow)) return false;
  let previous = 0;
  let bodyBytes = 0;
  for (const row of value) {
    if (row.ordinal <= previous) return false;
    previous = row.ordinal;
    bodyBytes += Buffer.byteLength(row.body, 'utf8');
  }
  return bodyBytes <= 1_048_576;
}

function physicalStep(value: unknown): value is IndexerPhysicalStep {
  const candidate = record(value);
  if (!candidate || typeof candidate.kind !== 'string') return false;
  switch (candidate.kind) {
    case 'plan-replacement':
      return exactKeys(candidate, ['kind', 'chatId', 'transcriptViewId', 'targetThrough'])
        && identifier(candidate.chatId)
        && identifier(candidate.transcriptViewId)
        && nonNegativeSafeInteger(candidate.targetThrough);
    case 'plan-append':
      return exactKeys(candidate, [
        'kind',
        'chatId',
        'transcriptViewId',
        'expectedAfterOrdinal',
        'targetThrough',
      ])
        && identifier(candidate.chatId)
        && identifier(candidate.transcriptViewId)
        && nonNegativeSafeInteger(candidate.expectedAfterOrdinal)
        && nonNegativeSafeInteger(candidate.targetThrough)
        && Number(candidate.targetThrough) >= Number(candidate.expectedAfterOrdinal);
    case 'stage-raw': {
      const expectedState = candidate.expectedState;
      return exactKeys(candidate, ['kind', 'expectedState', 'rows'])
        && searchState(expectedState)
        && rows(candidate.rows)
        && candidate.rows.every((row) => row.ordinal > expectedState.processedThrough
          && row.ordinal <= expectedState.targetThrough);
    }
    case 'build-terms':
    case 'activate':
    case 'cleanup':
    case 'complete-replacement-checkpoint':
      return exactKeys(candidate, ['kind', 'expectedState'])
        && searchState(candidate.expectedState);
    case 'advance-frontier':
      return exactKeys(candidate, ['kind', 'expectedState', 'throughOrdinal'])
        && searchState(candidate.expectedState)
        && nonNegativeSafeInteger(candidate.throughOrdinal)
        && Number(candidate.throughOrdinal) > candidate.expectedState.processedThrough
        && Number(candidate.throughOrdinal) <= candidate.expectedState.targetThrough;
    case 'start-removal':
      return exactKeys(candidate, ['kind', 'chatId']) && identifier(candidate.chatId);
    case 'mark-failed':
      return exactKeys(candidate, ['kind', 'expectedState', 'errorCode'])
        && searchState(candidate.expectedState)
        && failureCode(candidate.errorCode);
    case 'prune-mark':
      return exactKeys(candidate, ['kind', 'allowedChatIds', 'afterChatId'])
        && Array.isArray(candidate.allowedChatIds)
        && candidate.allowedChatIds.length <= 10_000
        && candidate.allowedChatIds.every(identifier)
        && (candidate.afterChatId === null || identifier(candidate.afterChatId));
    default:
      return false;
  }
}

function prunedCleanup(value: unknown): value is PrunedChatCleanup {
  const candidate = record(value);
  return Boolean(candidate)
    && exactKeys(candidate!, ['expectedState'])
    && searchState(candidate!.expectedState)
    && candidate!.expectedState.status === 'pending'
    && candidate!.expectedState.phase === 'removal-cleanup';
}

function physicalResult(value: unknown): value is PhysicalStepResult {
  const candidate = record(value);
  if (!candidate || typeof candidate.kind !== 'string') return false;
  switch (candidate.kind) {
    case 'sync-plan': {
      if (!exactKeys(candidate, ['kind', 'disposition', 'completion', 'state'])
          || !searchState(candidate.state)) return false;
      if (candidate.disposition === 'current') return candidate.completion === 'terminal';
      if (candidate.disposition === 'build' || candidate.disposition === 'cleanup') {
        return candidate.completion === 'continue';
      }
      return candidate.disposition === 'checkpoint' && candidate.completion === 'terminal';
    }
    case 'raw-staged':
      return exactKeys(candidate, ['kind', 'completion', 'state', 'acceptedRows'])
        && candidate.completion === 'continue'
        && searchState(candidate.state)
        && positiveSafeInteger(candidate.acceptedRows)
        && Number(candidate.acceptedRows) <= 16;
    case 'term-progress':
      return exactKeys(candidate, [
        'kind',
        'completion',
        'state',
        'insertedTerms',
        'insertedOccurrences',
        'completedChunk',
      ])
        && candidate.completion === 'continue'
        && searchState(candidate.state)
        && nonNegativeSafeInteger(candidate.insertedTerms)
        && Number(candidate.insertedTerms) <= 32
        && nonNegativeSafeInteger(candidate.insertedOccurrences)
        && typeof candidate.completedChunk === 'boolean';
    case 'frontier-progress':
      return exactKeys(candidate, ['kind', 'completion', 'state'])
        && candidate.completion === 'continue' && searchState(candidate.state);
    case 'indexed':
      return exactKeys(candidate, ['kind', 'completion', 'state'])
        && candidate.completion === 'terminal'
        && searchState(candidate.state)
        && candidate.state.status === 'indexed';
    case 'cleanup-progress':
      return exactKeys(candidate, [
        'kind',
        'completion',
        'state',
        'deletedTerms',
        'deletedRows',
        'deletedBodyBytes',
      ])
        && candidate.completion === 'continue'
        && searchState(candidate.state)
        && nonNegativeSafeInteger(candidate.deletedTerms)
        && Number(candidate.deletedTerms) <= 32
        && nonNegativeSafeInteger(candidate.deletedRows)
        && Number(candidate.deletedRows) <= 16
        && nonNegativeSafeInteger(candidate.deletedBodyBytes)
        && Number(candidate.deletedBodyBytes) <= 1_048_576;
    case 'replacement-checkpoint':
      return exactKeys(candidate, ['kind', 'completion', 'state'])
        && candidate.completion === 'terminal'
        && searchState(candidate.state)
        && candidate.state.phase === 'replacement-checkpoint';
    case 'chat-deleted':
      return exactKeys(candidate, ['kind', 'completion', 'chatId'])
        && candidate.completion === 'terminal' && identifier(candidate.chatId);
    case 'failure-recorded':
      return exactKeys(candidate, ['kind', 'completion', 'applied'])
        && candidate.completion === 'terminal' && typeof candidate.applied === 'boolean';
    case 'prune-progress':
      return exactKeys(candidate, [
        'kind',
        'completion',
        'cleanups',
        'nextAfterChatId',
        'done',
      ])
        && Array.isArray(candidate.cleanups)
        && candidate.cleanups.length <= 16
        && candidate.cleanups.every(prunedCleanup)
        && (candidate.nextAfterChatId === null || identifier(candidate.nextAfterChatId))
        && typeof candidate.done === 'boolean'
        && candidate.completion === (candidate.done ? 'terminal' : 'continue')
        && (candidate.done ? candidate.nextAfterChatId === null : candidate.nextAfterChatId !== null);
    case 'mutation-superseded':
      return exactKeys(candidate, ['kind', 'completion', 'chatId'])
        && candidate.completion === 'terminal' && identifier(candidate.chatId);
    default:
      return false;
  }
}

export function physicalStepResultRequiresContinuation(result: PhysicalStepResult): boolean {
  return result.completion === 'continue';
}

export function physicalStepResultRequiresSecureBarrier(result: PhysicalStepResult): boolean {
  return result.kind === 'replacement-checkpoint'
    || result.kind === 'chat-deleted'
    || (result.kind === 'sync-plan' && result.disposition === 'checkpoint');
}

function indexStatus(value: unknown): value is ChatSearchIndexStatus {
  const candidate = record(value);
  return Boolean(candidate)
    && exactKeys(candidate!, [
      'indexedChatCount',
      'pendingChatCount',
      'failedChatCount',
      'unsupportedChatCount',
    ])
    && ['indexedChatCount', 'pendingChatCount', 'failedChatCount', 'unsupportedChatCount']
      .every((key) => nonNegativeSafeInteger(candidate![key]));
}

function searchResult(value: unknown): value is ChatSearchResult {
  const candidate = record(value);
  if (!candidate || !exactKeys(candidate, [
    'chatId',
    'transcriptViewId',
    'score',
    'matchedMessageCount',
    'snippets',
  ])
      || !identifier(candidate.chatId)
      || !identifier(candidate.transcriptViewId)
      || typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)
      || !nonNegativeSafeInteger(candidate.matchedMessageCount)
      || !Array.isArray(candidate.snippets) || candidate.snippets.length > 3) return false;
  return candidate.snippets.every((valueSnippet) => {
    const snippet = record(valueSnippet);
    return Boolean(snippet)
      && exactKeys(snippet!, ['ordinal', 'role', 'timestamp', 'text'])
      && positiveSafeInteger(snippet!.ordinal)
      && ['user', 'assistant', 'tool', 'system'].includes(String(snippet!.role))
      && (snippet!.timestamp === null || boundedText(snippet!.timestamp, 256))
      && boundedText(snippet!.text, SEARCH_WORKER_MAX_ENVELOPE_BYTES, true);
  });
}

function allowedChats(value: unknown): value is readonly TranscriptSearchAllowedChat[] {
  return Array.isArray(value) && value.length <= SEARCH_READER_MAX_ALLOWLIST_ROWS
    && value.every((entry) => {
      const candidate = record(entry);
      return Boolean(candidate)
        && exactKeys(candidate!, ['chatId', 'transcriptViewId', 'throughOrdinal'])
        && identifier(candidate!.chatId)
        && identifier(candidate!.transcriptViewId)
        && nonNegativeSafeInteger(candidate!.throughOrdinal);
    });
}

function searchQuery(value: unknown): value is ChatSearchQueryV1 {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1
      || !Array.isArray(candidate.clauses)
      || candidate.clauses.length > CHAT_SEARCH_MAX_TERMS) return false;
  let tokenCount = 0;
  for (const valueClause of candidate.clauses) {
    const clause = record(valueClause);
    if (!clause || (clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens) || clause.tokens.length === 0) return false;
    tokenCount += clause.tokens.length;
    if (tokenCount > CHAT_SEARCH_MAX_WORDS) return false;
    for (const valueToken of clause.tokens) {
      const token = record(valueToken);
      if (!token || typeof token.text !== 'string' || typeof token.normalized !== 'string'
          || !hasWellFormedUtf16(token.text) || !hasWellFormedUtf16(token.normalized)
          || (token.match !== 'exact' && token.match !== 'prefix')
          || (clause.kind === 'phrase' && token.match !== 'exact')
          || (token.match === 'prefix'
            && [...token.text].length < CHAT_SEARCH_MIN_PREFIX_CHARS)) return false;
    }
  }
  return true;
}

function readerStepResult(value: unknown): value is ReaderStepResult {
  const candidate = record(value);
  if (!candidate || typeof candidate.kind !== 'string') return false;
  if (candidate.kind === 'continue') return exactKeys(candidate, ['kind']);
  if (candidate.kind !== 'result-chunk'
      || !Array.isArray(candidate.results)
      || candidate.results.length > 100
      || !candidate.results.every(searchResult)
      || !nonNegativeSafeInteger(candidate.chunkIndex)
      || typeof candidate.done !== 'boolean') return false;
  if (candidate.done) {
    return exactKeys(candidate, ['kind', 'chunkIndex', 'results', 'index', 'done'])
      && indexStatus(candidate.index);
  }
  return exactKeys(candidate, ['kind', 'chunkIndex', 'results', 'done']);
}

export function workerRequestIdentity(value: unknown): RequestIdentity | null {
  const candidate = requestIdentity(value);
  return candidate ? {
    requestId: Number(candidate.requestId),
    lifecycleEpoch: String(candidate.lifecycleEpoch),
  } : null;
}

export function workerGrantIdentity(value: unknown): PhysicalGrantIdentity | null {
  const candidate = requestIdentity(value);
  return candidate && grantIdentity(candidate) ? {
    requestId: Number(candidate.requestId),
    lifecycleEpoch: String(candidate.lifecycleEpoch),
    grantId: Number(candidate.grantId),
  } : null;
}

export function isIndexerRequest(value: unknown): value is IndexerRequest {
  const candidate = requestIdentity(value);
  if (!candidate || !workerEnvelopeWithinLimit(value)) return false;
  switch (candidate.type) {
    case 'open':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch', 'dbPath', 'walEpoch'])
        && boundedText(candidate.dbPath, 4_096)
        && positiveSafeInteger(candidate.walEpoch);
    case 'physical-step-grant':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
        'walEpoch',
        'step',
      ])
        && grantIdentity(candidate)
        && positiveSafeInteger(candidate.walEpoch)
        && physicalStep(candidate.step);
    case 'indexer-quiesce':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch']);
    case 'checkpoint':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'mode',
        'walEpoch',
      ])
        && candidate.mode === 'TRUNCATE'
        && positiveSafeInteger(candidate.walEpoch);
    default:
      return false;
  }
}

export function isReaderRequest(value: unknown): value is ReaderRequest {
  const candidate = requestIdentity(value);
  if (!candidate || !workerEnvelopeWithinLimit(value)) return false;
  switch (candidate.type) {
    case 'open':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch', 'dbPath'])
        && boundedText(candidate.dbPath, 4_096);
    case 'search-start':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'query',
        'limit',
      ])
        && searchQuery(candidate.query)
        && positiveSafeInteger(candidate.limit)
        && Number(candidate.limit) <= 100;
    case 'search-allowlist-chunk':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'chunkIndex',
        'allowedChats',
        'done',
      ])
        && nonNegativeSafeInteger(candidate.chunkIndex)
        && allowedChats(candidate.allowedChats)
        && typeof candidate.done === 'boolean';
    case 'reader-step-grant':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
      ]) && grantIdentity(candidate);
    case 'reader-quiesce':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch']);
    default:
      return false;
  }
}

export function isIndexerEvent(value: unknown): value is IndexerEvent {
  const candidate = requestIdentity(value);
  if (!candidate || !workerEnvelopeWithinLimit(value)) return false;
  switch (candidate.type) {
    case 'opened':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch', 'wal'])
        && isWalObservation(candidate.wal);
    case 'step-started':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch', 'grantId'])
        && grantIdentity(candidate);
    case 'physical-step-complete': {
      if (!grantIdentity(candidate) || !physicalResult(candidate.result)) return false;
      if (candidate.wal === undefined) {
        return exactKeys(candidate, [
          'type',
          'requestId',
          'lifecycleEpoch',
          'grantId',
          'result',
        ]);
      }
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
        'result',
        'wal',
      ]) && isWalObservation(candidate.wal);
    }
    case 'indexer-quiesced':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch']);
    case 'checkpoint-complete':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'busy',
        'logFrames',
        'checkpointedFrames',
        'wal',
      ])
        && candidate.busy === 0
        && candidate.logFrames === 0
        && candidate.checkpointedFrames === 0
        && isWalObservation(candidate.wal)
        && candidate.wal.logFrames === 0
        && candidate.wal.checkpointedFrames === 0;
    case 'error': {
      const keys = [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
        'code',
        'retryable',
      ];
      if (!exactKeys(candidate, candidate.wal === undefined ? keys : [...keys, 'wal'])
          || (candidate.grantId !== null && !positiveSafeInteger(candidate.grantId))
          || !failureCode(candidate.code)
          || typeof candidate.retryable !== 'boolean') {
        return false;
      }
      return candidate.wal === undefined
        || (isIndexerWalAuthoritativeErrorCode(candidate.code)
          && isWalObservation(candidate.wal));
    }
    default:
      return false;
  }
}

export function isReaderEvent(value: unknown): value is ReaderEvent {
  const candidate = requestIdentity(value);
  if (!candidate || !workerEnvelopeWithinLimit(value)) return false;
  switch (candidate.type) {
    case 'opened':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch']);
    case 'search-input-ack':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'chunkIndex',
        'ready',
      ])
        && (candidate.chunkIndex === null || nonNegativeSafeInteger(candidate.chunkIndex))
        && typeof candidate.ready === 'boolean';
    case 'reader-step-complete':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
        'result',
      ])
        && grantIdentity(candidate)
        && readerStepResult(candidate.result);
    case 'reader-quiesced':
      return exactKeys(candidate, ['type', 'requestId', 'lifecycleEpoch']);
    case 'error':
      return exactKeys(candidate, [
        'type',
        'requestId',
        'lifecycleEpoch',
        'grantId',
        'code',
        'retryable',
      ])
        && (candidate.grantId === null || positiveSafeInteger(candidate.grantId))
        && failureCode(candidate.code)
        && typeof candidate.retryable === 'boolean';
    default:
      return false;
  }
}

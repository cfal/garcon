import type {
  ChatSearchIndexStatus,
  ChatSearchResult,
  ChatSearchSnippetRole,
} from '../../../common/chat-search.js';
import type { TranscriptBuildSource } from './source-types.js';

export interface SearchMessageRowInput {
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  body: string;
}

export interface HistoricalSearchMessageRow extends SearchMessageRowInput {
  messageOrdinal: number;
}

interface WorkerRequestBase {
  requestId: number;
  lifecycleEpoch: number;
}

export type TranscriptSearchWorkerRequest =
  | (WorkerRequestBase & { type: 'open'; dbPath: string })
  | (WorkerRequestBase & {
      type: 'rebuild-chat';
      chatId: string;
      generation: number;
      buildSource: TranscriptBuildSource;
    })
  | (WorkerRequestBase & {
      type: 'append';
      chatId: string;
      generation: number;
      rows: SearchMessageRowInput[];
    })
  | (WorkerRequestBase & {
      type: 'mark-dirty';
      chatId: string;
      generation: number;
    })
  | (WorkerRequestBase & {
      type: 'mark-unsupported';
      chatId: string;
      generation: number;
      reasonCode: string;
    })
  | (WorkerRequestBase & { type: 'delete-chat'; chatId: string; generation: number })
  | (WorkerRequestBase & {
      type: 'search';
      query: string;
      textTokens?: string[];
      allowedChatIds: string[];
      limit?: number;
    })
  | (WorkerRequestBase & { type: 'close' });

export type TranscriptSearchWorkerErrorCode =
  | 'INVALID_REQUEST'
  | 'OPEN_FAILED'
  | 'SCHEMA_MISMATCH'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'SQLITE_ERROR'
  | 'SEARCH_FAILED'
  | 'CANCELLED'
  | 'CLOSE_FAILED';

interface WorkerResponseBase {
  requestId: number;
  lifecycleEpoch: number;
}

export type TranscriptSearchWorkerResponse =
  | (WorkerResponseBase & { type: 'opened' })
  | (WorkerResponseBase & { type: 'ack' })
  | (WorkerResponseBase & {
      type: 'search-result';
      results: ChatSearchResult[];
      index: ChatSearchIndexStatus;
    })
  | (WorkerResponseBase & { type: 'closed' })
  | (WorkerResponseBase & {
      type: 'error';
      code: TranscriptSearchWorkerErrorCode;
      message: string;
    });

export interface TranscriptSearchProgressEvent {
  type: 'progress';
  lifecycleEpoch: number;
  phase: 'building' | 'ready' | 'degraded';
  indexedChatCount: number;
  pendingChatCount: number;
  failedChatCount: number;
  unsupportedChatCount: number;
  processedRowCount: number;
}

export type TranscriptSearchWorkerMessage =
  | TranscriptSearchWorkerResponse
  | TranscriptSearchProgressEvent;

export function isTranscriptSearchWorkerMessage(
  value: unknown,
): value is TranscriptSearchWorkerMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'opened'
    || type === 'ack'
    || type === 'search-result'
    || type === 'closed'
    || type === 'error'
    || type === 'progress';
}


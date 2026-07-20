import type { ChatMessage } from '@garcon/common/chat-types';
import type { ChatSearchIndexStatus, ChatSearchQueryV1, ChatSearchResult } from '@garcon/common/chat-search';
import { CHAT_SEARCH_MIN_PREFIX_CHARS } from '@garcon/common/chat-search';
import type {
  TranscriptSearchCatalogSnapshot,
  TranscriptSearchGeneration,
} from './transcript-search-service.js';

export interface TranscriptIndexModuleRegistration {
  readonly agentId: string;
  readonly moduleUrl: string;
  readonly apiVersion: 1;
}

interface RequestBase {
  readonly requestId: number;
  readonly lifecycleEpoch: string;
}

export type IndexerRequest =
  | (RequestBase & {
      readonly type: 'open';
      readonly operationEpoch: string;
      readonly dbPath: string;
      readonly scratchDirectory: string;
      readonly modules: readonly TranscriptIndexModuleRegistration[];
      readonly quarantines: readonly { readonly chatId: string; readonly sourceSignature: string }[];
    })
  | (RequestBase & {
      readonly type: 'catalog-chunk';
      readonly generation: TranscriptSearchGeneration;
      readonly chunkIndex: number;
      readonly chats: TranscriptSearchCatalogSnapshot['chats'];
      readonly done: boolean;
    })
  | (RequestBase & {
      readonly type: 'source-dirty';
      readonly chatId: string;
      readonly generation: TranscriptSearchGeneration;
    })
  | (RequestBase & {
      readonly type: 'delete-chat';
      readonly chatId: string;
      readonly generation: TranscriptSearchGeneration;
    })
  | (RequestBase & {
      readonly type: 'carry-over-chunk';
      readonly chunkIndex: number;
      readonly revision: string;
      readonly messages: readonly ChatMessage[];
      readonly done: boolean;
      readonly code?: string;
      readonly retryable?: boolean;
    })
  | (RequestBase & { readonly type: 'close' });

export type IndexerEvent =
  | (RequestBase & { readonly type: 'opened' | 'ack' | 'closed' })
  | (RequestBase & {
      readonly type: 'error';
      readonly code: string;
      readonly retryable: boolean;
    })
  | {
      readonly type: 'progress';
      readonly lifecycleEpoch: string;
      readonly status: ChatSearchIndexStatus;
      readonly queueDepth: number;
      readonly oldestPendingMs: number;
    }
  | {
      readonly type: 'source-status';
      readonly lifecycleEpoch: string;
      readonly chatId: string;
      readonly agentId: string;
      readonly generation: TranscriptSearchGeneration;
      readonly state: 'sealed' | 'pending' | 'failed' | 'unsupported';
      readonly errorCode: string | null;
      readonly retryable: boolean | null;
    }
  | {
      readonly type: 'refresh-source-reference';
      readonly lifecycleEpoch: string;
      readonly chatId: string;
      readonly agentId: string;
      readonly generation: TranscriptSearchGeneration;
      readonly sourceDescriptorHash: string;
      readonly reasonCode: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly type: 'job-state';
      readonly lifecycleEpoch: string;
      readonly state: 'started' | 'finished';
      readonly chatId: string;
      readonly sourceSignature: string;
    }
  | {
      readonly type: 'fatal';
      readonly lifecycleEpoch: string;
      readonly code: string;
    }
  | (RequestBase & {
      readonly type: 'carry-over-open';
      readonly chatId: string;
      readonly expectedRevision: string;
      readonly currentAgentId: string;
      readonly currentModel: string;
    })
  | (RequestBase & { readonly type: 'carry-over-pull' })
  | (RequestBase & { readonly type: 'carry-over-cancel' });

export type ReaderRequest =
  | (RequestBase & { readonly type: 'open'; readonly dbPath: string })
  | (RequestBase & {
      readonly type: 'search-start';
      readonly query: ChatSearchQueryV1;
      readonly limit: number;
    })
  | (RequestBase & {
      readonly type: 'search-allowlist-chunk';
      readonly chunkIndex: number;
      readonly allowedChatIds: readonly string[];
      readonly done: boolean;
    })
  | (RequestBase & { readonly type: 'close' });

export type ReaderEvent =
  | (RequestBase & { readonly type: 'opened' | 'closed' })
  | (RequestBase & {
      readonly type: 'search-result';
      readonly results: readonly ChatSearchResult[];
      readonly index: ChatSearchIndexStatus;
    })
  | (RequestBase & { readonly type: 'error'; readonly code: string; readonly retryable: boolean });

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function requestBase(value: unknown): UnknownRecord | null {
  const candidate = record(value);
  return candidate
    && Number.isSafeInteger(candidate.requestId) && Number(candidate.requestId) > 0
    && typeof candidate.lifecycleEpoch === 'string' && candidate.lifecycleEpoch.length > 0
    && typeof candidate.type === 'string'
    ? candidate
    : null;
}

function generation(value: unknown): boolean {
  const candidate = record(value);
  return Boolean(candidate)
    && typeof candidate!.epoch === 'string'
    && candidate!.epoch.length > 0
    && Number.isSafeInteger(candidate!.sequence)
    && Number(candidate!.sequence) > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function failureCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function jsonBytesWithin(value: unknown, maximum: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maximum;
  } catch {
    return false;
  }
}

function indexStatus(value: unknown): boolean {
  const candidate = record(value);
  return Boolean(candidate)
    && ['indexedChatCount', 'pendingChatCount', 'failedChatCount', 'unsupportedChatCount']
      .every((key) => Number.isSafeInteger(candidate![key]) && Number(candidate![key]) >= 0);
}

function searchResult(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate
      || typeof candidate.chatId !== 'string'
      || candidate.chatId.length === 0
      || typeof candidate.score !== 'number'
      || !Number.isFinite(candidate.score)
      || !Number.isSafeInteger(candidate.matchedMessageCount)
      || Number(candidate.matchedMessageCount) < 0
      || !Array.isArray(candidate.snippets)
      || candidate.snippets.length > 3) return false;
  return candidate.snippets.every((valueSnippet) => {
    const snippet = record(valueSnippet);
    return Boolean(snippet)
      && Number.isSafeInteger(snippet!.messageOrdinal)
      && Number(snippet!.messageOrdinal) >= 0
      && ['user', 'assistant', 'tool', 'system'].includes(String(snippet!.role))
      && (snippet!.timestamp === null || typeof snippet!.timestamp === 'string')
      && typeof snippet!.text === 'string';
  });
}

function searchQuery(value: unknown): boolean {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1
      || !Array.isArray(candidate.clauses) || candidate.clauses.length > 16
      || !jsonBytesWithin(candidate, 64 * 1024)) return false;
  let tokenCount = 0;
  for (const valueClause of candidate.clauses) {
    const clause = record(valueClause);
    if (!clause || (clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens) || clause.tokens.length === 0) return false;
    tokenCount += clause.tokens.length;
    if (tokenCount > 32) return false;
    for (const valueToken of clause.tokens) {
      const token = record(valueToken);
      if (!token || typeof token.text !== 'string' || typeof token.normalized !== 'string'
          || (token.match !== 'exact' && token.match !== 'prefix')
          || (clause.kind === 'phrase' && token.match !== 'exact')
          || (token.match === 'prefix'
            && [...token.text].length < CHAT_SEARCH_MIN_PREFIX_CHARS)) return false;
    }
  }
  return true;
}

export function workerRequestIdentity(
  value: unknown,
): { readonly requestId: number; readonly lifecycleEpoch: string } | null {
  const candidate = requestBase(value);
  return candidate
    ? { requestId: Number(candidate.requestId), lifecycleEpoch: String(candidate.lifecycleEpoch) }
    : null;
}

export function isIndexerRequest(value: unknown): value is IndexerRequest {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'open':
      return typeof candidate.operationEpoch === 'string'
        && typeof candidate.dbPath === 'string'
        && typeof candidate.scratchDirectory === 'string'
        && Array.isArray(candidate.modules) && candidate.modules.length <= 256
        && candidate.modules.every((entry) => {
          const module = record(entry);
          return Boolean(module)
            && typeof module!.agentId === 'string'
            && typeof module!.moduleUrl === 'string' && module!.moduleUrl.length <= 64 * 1024
            && module!.apiVersion === 1;
        })
        && Array.isArray(candidate.quarantines) && candidate.quarantines.length <= 10_000
        && candidate.quarantines.every((entry) => {
          const quarantine = record(entry);
          return Boolean(quarantine)
            && typeof quarantine!.chatId === 'string'
            && typeof quarantine!.sourceSignature === 'string';
        });
    case 'catalog-chunk':
      return generation(candidate.generation)
        && Number.isSafeInteger(candidate.chunkIndex)
        && Array.isArray(candidate.chats) && candidate.chats.length <= 500
        && jsonBytesWithin(candidate.chats, 8 * 1024 * 1024)
        && typeof candidate.done === 'boolean';
    case 'source-dirty':
    case 'delete-chat':
      return typeof candidate.chatId === 'string' && candidate.chatId.length > 0
        && generation(candidate.generation);
    case 'carry-over-chunk':
      return Number.isSafeInteger(candidate.chunkIndex)
        && typeof candidate.revision === 'string'
        && Array.isArray(candidate.messages) && candidate.messages.length <= 250
        && jsonBytesWithin(candidate.messages, 8 * 1024 * 1024)
        && typeof candidate.done === 'boolean'
        && (candidate.code === undefined || failureCode(candidate.code))
        && (candidate.retryable === undefined || typeof candidate.retryable === 'boolean');
    case 'close':
      return true;
    default:
      return false;
  }
}

export function isReaderRequest(value: unknown): value is ReaderRequest {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'open':
      return typeof candidate.dbPath === 'string' && candidate.dbPath.length > 0;
    case 'search-start':
      return searchQuery(candidate.query)
        && Number.isSafeInteger(candidate.limit)
        && Number(candidate.limit) >= 1
        && Number(candidate.limit) <= 100;
    case 'search-allowlist-chunk':
      return Number.isSafeInteger(candidate.chunkIndex)
        && stringArray(candidate.allowedChatIds)
        && candidate.allowedChatIds.length <= 2_000
        && jsonBytesWithin(candidate.allowedChatIds, 8 * 1024 * 1024)
        && typeof candidate.done === 'boolean';
    case 'close':
      return true;
    default:
      return false;
  }
}

export function isIndexerEvent(value: unknown): value is IndexerEvent {
  const candidate = record(value);
  if (!candidate || typeof candidate.type !== 'string'
      || typeof candidate.lifecycleEpoch !== 'string'
      || candidate.lifecycleEpoch.length === 0) return false;
  if (candidate.type === 'progress') {
    return indexStatus(candidate.status)
      && Number.isSafeInteger(candidate.queueDepth) && Number(candidate.queueDepth) >= 0
      && typeof candidate.oldestPendingMs === 'number' && candidate.oldestPendingMs >= 0;
  }
  if (candidate.type === 'source-status') {
    return typeof candidate.chatId === 'string'
      && typeof candidate.agentId === 'string'
      && generation(candidate.generation)
      && ['sealed', 'pending', 'failed', 'unsupported'].includes(String(candidate.state))
      && (candidate.errorCode === null || failureCode(candidate.errorCode))
      && (candidate.retryable === null || typeof candidate.retryable === 'boolean');
  }
  if (candidate.type === 'refresh-source-reference') {
    return typeof candidate.chatId === 'string'
      && typeof candidate.agentId === 'string'
      && typeof candidate.sourceDescriptorHash === 'string'
      && /^[a-f0-9]{64}$/.test(candidate.sourceDescriptorHash)
      && failureCode(candidate.reasonCode)
      && generation(candidate.generation)
      && typeof candidate.retryAfterMs === 'number' && candidate.retryAfterMs >= 0;
  }
  if (candidate.type === 'job-state') {
    return (candidate.state === 'started' || candidate.state === 'finished')
      && typeof candidate.chatId === 'string'
      && typeof candidate.sourceSignature === 'string'
      && /^[a-f0-9]{64}$/.test(candidate.sourceSignature);
  }
  if (candidate.type === 'fatal') return failureCode(candidate.code);
  if (!requestBase(candidate)) return false;
  switch (candidate.type) {
    case 'opened':
    case 'ack':
    case 'closed':
    case 'carry-over-pull':
    case 'carry-over-cancel':
      return true;
    case 'error':
      return failureCode(candidate.code) && typeof candidate.retryable === 'boolean';
    case 'carry-over-open':
      return typeof candidate.chatId === 'string'
        && typeof candidate.expectedRevision === 'string'
        && typeof candidate.currentAgentId === 'string'
        && typeof candidate.currentModel === 'string';
    default:
      return false;
  }
}

export function isReaderEvent(value: unknown): value is ReaderEvent {
  const candidate = requestBase(value);
  if (!candidate) return false;
  switch (candidate.type) {
    case 'opened':
    case 'closed':
      return true;
    case 'error':
      return failureCode(candidate.code) && typeof candidate.retryable === 'boolean';
    case 'search-result':
      return Array.isArray(candidate.results) && candidate.results.length <= 100
        && candidate.results.every(searchResult)
        && indexStatus(candidate.index);
    default:
      return false;
  }
}

export function compareGeneration(
  left: TranscriptSearchGeneration,
  right: TranscriptSearchGeneration,
): number | null {
  if (left.epoch !== right.epoch) return null;
  return left.sequence - right.sequence;
}

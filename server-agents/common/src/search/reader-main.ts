import type { Database } from 'bun:sqlite';
import { searchTranscriptIndexV1 } from './query.js';
import { openSearchReadDatabase } from './schema.js';
import type { ReaderEvent, ReaderRequest } from './worker-protocol.js';
import { isReaderRequest, workerRequestIdentity } from './worker-protocol.js';

let db: Database | null = null;
let lifecycleEpoch = '';
let closing = false;
const searches = new Map<number, {
  readonly query: Extract<ReaderRequest, { type: 'search-start' }>['query'];
  readonly limit: number;
  readonly allowedChatIds: string[];
  nextChunkIndex: number;
}>();

function post(message: ReaderEvent): void {
  self.postMessage(message);
}

function response(request: ReaderRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function handle(request: ReaderRequest): void {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open':
        lifecycleEpoch = request.lifecycleEpoch;
        db = openSearchReadDatabase(request.dbPath);
        post({ type: 'opened', ...response(request) });
        return;
      case 'search-start': {
        if (!db || closing) throw new Error('READER_UNAVAILABLE');
        if (searches.has(request.requestId)
            || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
          throw new Error('INVALID_SEARCH_REQUEST');
        }
        searches.set(request.requestId, {
          query: request.query,
          limit: request.limit,
          allowedChatIds: [],
          nextChunkIndex: 0,
        });
        return;
      }
      case 'search-allowlist-chunk': {
        if (!db || closing) throw new Error('READER_UNAVAILABLE');
        const search = searches.get(request.requestId);
        if (!search || search.nextChunkIndex !== request.chunkIndex
            || request.allowedChatIds.length > 2_000
            || Buffer.byteLength(JSON.stringify(request.allowedChatIds)) > 8 * 1024 * 1024) {
          searches.delete(request.requestId);
          throw new Error('INVALID_SEARCH_FRAME');
        }
        search.allowedChatIds.push(...request.allowedChatIds);
        search.nextChunkIndex += 1;
        if (!request.done) return;
        searches.delete(request.requestId);
        const result = searchTranscriptIndexV1(db, {
          query: search.query,
          allowedChatIds: search.allowedChatIds,
          limit: search.limit,
        });
        post({ type: 'search-result', ...response(request), ...result });
        return;
      }
      case 'close':
        closing = true;
        searches.clear();
        db?.close();
        db = null;
        post({ type: 'closed', ...response(request) });
        self.close();
        return;
    }
  } catch (error) {
    if (request.type === 'search-start' || request.type === 'search-allowlist-chunk') {
      searches.delete(request.requestId);
    }
    const explicitCode = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : null;
    const code = explicitCode ?? (error instanceof RangeError ? 'INVALID_SEARCH_REQUEST' : 'READER_INTERNAL');
    post({
      type: 'error',
      ...response(request),
      code,
      retryable: code === 'READER_INTERNAL' || code === 'READER_UNAVAILABLE',
    });
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isReaderRequest(event.data)) {
    const identity = workerRequestIdentity(event.data);
    if (identity) post({
      type: 'error',
      ...identity,
      code: 'INVALID_READER_REQUEST',
      retryable: false,
    });
    return;
  }
  handle(event.data);
};

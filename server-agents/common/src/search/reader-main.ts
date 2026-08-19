import type { Database } from 'bun:sqlite';
import type { ChatSearchIndexStatus, ChatSearchResult } from '@garcon/common/chat-search';
import {
  type CompiledTranscriptSearchQuery,
  type TranscriptSearchAllowlist,
  type TranscriptSearchReaderSession,
  compileTranscriptSearchQueryV1,
  createTranscriptSearchAllowlist,
  createTranscriptSearchReaderSessionFromAllowlist,
} from './query.js';
import { openSearchReadDatabase } from './schema.js';
import { SearchTokenizer } from './tokenizer.js';
import type {
  ReaderEvent,
  ReaderRequest,
  ReaderStepResult,
} from './worker-protocol.js';
import {
  isReaderEvent,
  isReaderRequest,
  workerEnvelopeWithinLimit,
  workerGrantIdentity,
  workerRequestIdentity,
} from './worker-protocol.js';

interface SearchJob {
  readonly compiled: CompiledTranscriptSearchQuery;
  readonly limit: number;
  readonly allowlist: TranscriptSearchAllowlist;
  nextInputChunkIndex: number;
  ready: boolean;
  session: TranscriptSearchReaderSession | null;
  output: {
    readonly results: readonly ChatSearchResult[];
    readonly index: ChatSearchIndexStatus;
  } | null;
  nextResultIndex: number;
  nextResultChunkIndex: number;
}

let db: Database | null = null;
let tokenizer: SearchTokenizer | null = null;
let lifecycleEpoch = '';
let closing = false;
let activeRequestId: number | null = null;
const searches = new Map<number, SearchJob>();

export function assertReaderEventForPost(message: unknown): asserts message is ReaderEvent {
  if (!isReaderEvent(message)) throw new Error('INVALID_READER_EVENT');
}

function post(message: ReaderEvent): void {
  assertReaderEventForPost(message);
  self.postMessage(message);
}

function response(request: ReaderRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) {
    return error.message;
  }
  return error instanceof RangeError ? 'INVALID_SEARCH_QUERY' : 'READER_INTERNAL';
}

function retryable(code: string): boolean {
  return code === 'READER_INTERNAL'
    || code === 'READER_UNAVAILABLE'
    || code === 'SEARCH_INDEX_CORRUPT';
}

function cancelSearch(requestId: number): void {
  const search = searches.get(requestId);
  try {
    if (search?.session) search.session.cancel();
    else search?.allowlist.close();
  } finally {
    searches.delete(requestId);
    if (activeRequestId === requestId) activeRequestId = null;
  }
}

function resultEnvelope(
  request: Extract<ReaderRequest, { type: 'reader-step-grant' }>,
  result: ReaderStepResult,
): ReaderEvent {
  return { type: 'reader-step-complete', ...response(request), grantId: request.grantId, result };
}

function nextResultChunk(
  request: Extract<ReaderRequest, { type: 'reader-step-grant' }>,
  search: SearchJob,
): ReaderStepResult {
  const output = search.output;
  if (!output) throw new Error('INVALID_READER_STEP');
  const from = search.nextResultIndex;
  if (from === output.results.length) {
    search.nextResultChunkIndex += 1;
    return {
      kind: 'result-chunk',
      chunkIndex: search.nextResultChunkIndex - 1,
      results: [],
      index: output.index,
      done: true,
    };
  }

  let acceptedEnd = from;
  let acceptedDone = false;
  for (let end = from + 1; end <= output.results.length; end += 1) {
    const done = end === output.results.length;
    const result: ReaderStepResult = done
      ? {
          kind: 'result-chunk',
          chunkIndex: search.nextResultChunkIndex,
          results: output.results.slice(from, end),
          index: output.index,
          done: true,
        }
      : {
          kind: 'result-chunk',
          chunkIndex: search.nextResultChunkIndex,
          results: output.results.slice(from, end),
          done: false,
        };
    if (!workerEnvelopeWithinLimit(resultEnvelope(request, result))) {
      if (done) {
        const nonFinal: ReaderStepResult = {
          kind: 'result-chunk',
          chunkIndex: search.nextResultChunkIndex,
          results: output.results.slice(from, end),
          done: false,
        };
        if (workerEnvelopeWithinLimit(resultEnvelope(request, nonFinal))) acceptedEnd = end;
      }
      break;
    }
    acceptedEnd = end;
    acceptedDone = done;
  }
  if (acceptedEnd === from) throw new Error('SEARCH_WORKER_ENVELOPE_LIMIT');
  const results = output.results.slice(from, acceptedEnd);
  const chunkIndex = search.nextResultChunkIndex;
  search.nextResultIndex = acceptedEnd;
  search.nextResultChunkIndex += 1;
  return acceptedDone
    ? { kind: 'result-chunk', chunkIndex, results, index: output.index, done: true }
    : { kind: 'result-chunk', chunkIndex, results, done: false };
}

function handleReaderStep(request: Extract<ReaderRequest, { type: 'reader-step-grant' }>): void {
  const search = searches.get(request.requestId);
  if (!db || closing || !search?.ready || !search.session) {
    throw new Error('INVALID_READER_STEP');
  }
  if (activeRequestId !== null && activeRequestId !== request.requestId) {
    throw new Error('READER_BUSY');
  }
  if (search.output) {
    const result = nextResultChunk(request, search);
    post(resultEnvelope(request, result));
    if (result.kind === 'result-chunk' && result.done) searches.delete(request.requestId);
    return;
  }

  activeRequestId = request.requestId;
  const step = search.session.step();
  if (step.type === 'continue') {
    post(resultEnvelope(request, { kind: 'continue' }));
    return;
  }
  activeRequestId = null;
  search.output = step.result;
  const result = nextResultChunk(request, search);
  post(resultEnvelope(request, result));
  if (result.kind === 'result-chunk' && result.done) searches.delete(request.requestId);
}

function quiesce(request: Extract<ReaderRequest, { type: 'reader-quiesce' }>): void {
  closing = true;
  for (const requestId of [...searches.keys()]) {
    try {
      cancelSearch(requestId);
    } catch {
      // Closing the connection retires any remaining TEMP state.
    }
  }
  db?.close();
  db = null;
  tokenizer?.close();
  tokenizer = null;
  post({ type: 'reader-quiesced', ...response(request) });
  process.exit(0);
}

function handle(request: ReaderRequest): void {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open': {
        if (db || tokenizer || closing) throw new Error('READER_UNAVAILABLE');
        lifecycleEpoch = request.lifecycleEpoch;
        tokenizer = SearchTokenizer.create();
        db = openSearchReadDatabase(request.dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
        post({ type: 'opened', ...response(request) });
        return;
      }
      case 'search-start': {
        if (!db || !tokenizer || closing || searches.size > 0) {
          throw new Error('INVALID_SEARCH_REQUEST');
        }
        const compiled = compileTranscriptSearchQueryV1(tokenizer, request.query);
        const allowlist = createTranscriptSearchAllowlist(db);
        searches.set(request.requestId, {
          compiled,
          limit: request.limit,
          allowlist,
          nextInputChunkIndex: 0,
          ready: false,
          session: null,
          output: null,
          nextResultIndex: 0,
          nextResultChunkIndex: 0,
        });
        post({ type: 'search-input-ack', ...response(request), chunkIndex: null, ready: false });
        return;
      }
      case 'search-allowlist-chunk': {
        if (!db || closing) throw new Error('READER_UNAVAILABLE');
        const search = searches.get(request.requestId);
        if (!search || search.ready || search.nextInputChunkIndex !== request.chunkIndex) {
          throw new Error('INVALID_SEARCH_FRAME');
        }
        search.allowlist.append(request.allowedChats);
        search.nextInputChunkIndex += 1;
        if (request.done) {
          search.ready = true;
          search.session = createTranscriptSearchReaderSessionFromAllowlist(
            db,
            search.compiled,
            search.allowlist,
            {
            limit: search.limit,
            },
          );
        }
        post({
          type: 'search-input-ack',
          ...response(request),
          chunkIndex: request.chunkIndex,
          ready: search.ready,
        });
        return;
      }
      case 'reader-step-grant':
        handleReaderStep(request);
        return;
      case 'reader-quiesce':
        quiesce(request);
        return;
    }
  } catch (error) {
    if (request.type === 'open') {
      db?.close(false);
      db = null;
      tokenizer?.close();
      tokenizer = null;
    }
    if (request.type === 'search-start'
        || request.type === 'search-allowlist-chunk'
        || request.type === 'reader-step-grant') {
      cancelSearch(request.requestId);
    }
    const code = errorCode(error);
    post({
      type: 'error',
      ...response(request),
      grantId: request.type === 'reader-step-grant' ? request.grantId : null,
      code,
      retryable: retryable(code),
    });
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isReaderRequest(event.data)) {
    const identity = workerRequestIdentity(event.data);
    if (identity) {
      cancelSearch(identity.requestId);
      post({
        type: 'error',
        ...identity,
        grantId: workerGrantIdentity(event.data)?.grantId ?? null,
        code: 'INVALID_READER_REQUEST',
        retryable: false,
      });
    }
    return;
  }
  handle(event.data);
};

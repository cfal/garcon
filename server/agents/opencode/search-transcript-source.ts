import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createHash } from 'crypto';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  searchBatchLimitReached,
  searchBatchWouldExceed,
  throwIfSearchLoadAborted,
} from '../shared/search-transcript-batches.js';
import {
  convertOpenCodeStoredMessages,
  fetchOpenCodeStoredMessages,
  type OpenCodeClientGetter,
} from './history-loader.js';

type OpenCodeSource = Extract<DetachedTranscriptSource, { kind: 'opencode-api' }>;

export async function probeOpenCodeSearchTranscript(
  source: OpenCodeSource,
  signal?: AbortSignal,
): Promise<string | null> {
  const client = createOpencodeClient({ baseUrl: source.baseUrl });
  const result = await client.session.get({
    sessionID: source.sessionId,
    directory: source.directory,
  }, signal ? { signal } : undefined);
  const data = result.data as { time?: { updated?: unknown } } | undefined;
  const updated = data?.time?.updated;
  if (typeof updated !== 'number' && typeof updated !== 'string') return null;
  const identity = createHash('sha256')
    .update(JSON.stringify({ sessionId: source.sessionId, directory: source.directory }))
    .digest('hex');
  return `opencode-api:${identity}:${String(updated)}`;
}

export async function* loadOpenCodeSearchTranscript(
  source: OpenCodeSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const getClient = (async () => createOpencodeClient({ baseUrl: source.baseUrl })) as OpenCodeClientGetter;
  const stored = await fetchOpenCodeStoredMessages(source.sessionId, getClient, {
    directory: source.directory,
    signal: options.signal,
    throwOnError: true,
  });
  let batch: (typeof stored)[number][] = [];
  let batchBytes = 0;
  for (const message of stored) {
    throwIfSearchLoadAborted(options.signal);
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    if (messageBytes > SEARCH_TRANSCRIPT_MAX_RECORD_BYTES) {
      throw new Error(`OpenCode transcript record exceeds ${SEARCH_TRANSCRIPT_MAX_RECORD_BYTES} bytes`);
    }
    if (searchBatchWouldExceed(batch.length, batchBytes, messageBytes, options.batchSize)) {
      yield convertOpenCodeStoredMessages(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(message);
    batchBytes += messageBytes;
    if (!searchBatchLimitReached(batch.length, batchBytes, options.batchSize)) continue;
    yield convertOpenCodeStoredMessages(batch);
    batch = [];
    batchBytes = 0;
  }
  if (batch.length > 0) yield convertOpenCodeStoredMessages(batch);
}

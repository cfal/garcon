import type {
  ChatSearchQueryV1,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  MAX_ALLOWLIST_PER_FRAME,
  MAX_FRAME_BYTES,
  type ReaderRequest,
} from './worker-protocol.js';
import type { TranscriptSearchOrder } from './worker-protocol.js';
import type { WorkerRequestInput } from './worker-supervisor.js';

export function searchFrames(
  query: ChatSearchQueryV1,
  allowedChats: readonly TranscriptSearchAllowedChat[],
  order: TranscriptSearchOrder,
  offset: number,
  limit: number,
): readonly WorkerRequestInput<ReaderRequest>[] {
  const frames: WorkerRequestInput<ReaderRequest>[] = [{
    type: 'search-start',
    query,
    order,
    offset,
    limit,
  }];
  if (allowedChats.length === 0) {
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: 0,
      allowedChats: [],
      done: true,
    });
    return frames;
  }
  for (let chunkStart = 0; chunkStart < allowedChats.length; chunkStart += MAX_ALLOWLIST_PER_FRAME) {
    // Chunk order carries server-authoritative priority for allowlist-ordered searches.
    const chunk = allowedChats.slice(chunkStart, chunkStart + MAX_ALLOWLIST_PER_FRAME);
    if (Buffer.byteLength(JSON.stringify(chunk)) > MAX_FRAME_BYTES) {
      throw new Error('SEARCH_ALLOWLIST_TOO_LARGE');
    }
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: chunkStart / MAX_ALLOWLIST_PER_FRAME,
      allowedChats: chunk,
      done: chunkStart + chunk.length >= allowedChats.length,
    });
  }
  return frames;
}

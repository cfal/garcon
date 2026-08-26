import type {
  ChatSearchQueryV1,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  MAX_ALLOWLIST_PER_FRAME,
  MAX_FRAME_BYTES,
  type ReaderRequest,
} from './worker-protocol.js';
import type { WorkerRequestInput } from './worker-supervisor.js';

export function searchFrames(
  query: ChatSearchQueryV1,
  allowedChats: readonly TranscriptSearchAllowedChat[],
  limit: number,
): readonly WorkerRequestInput<ReaderRequest>[] {
  const frames: WorkerRequestInput<ReaderRequest>[] = [{ type: 'search-start', query, limit }];
  if (allowedChats.length === 0) {
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: 0,
      allowedChats: [],
      done: true,
    });
    return frames;
  }
  for (let offset = 0; offset < allowedChats.length; offset += MAX_ALLOWLIST_PER_FRAME) {
    const chunk = allowedChats.slice(offset, offset + MAX_ALLOWLIST_PER_FRAME);
    if (Buffer.byteLength(JSON.stringify(chunk)) > MAX_FRAME_BYTES) {
      throw new Error('SEARCH_ALLOWLIST_TOO_LARGE');
    }
    frames.push({
      type: 'search-allowlist-chunk',
      chunkIndex: offset / MAX_ALLOWLIST_PER_FRAME,
      allowedChats: chunk,
      done: offset + chunk.length >= allowedChats.length,
    });
  }
  return frames;
}

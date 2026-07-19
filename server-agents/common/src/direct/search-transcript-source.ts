import { AssistantMessage, UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import type { DetachedTranscriptSource } from '@garcon/server-agent-common/search/source-types';
import type { SearchTranscriptLoadOptions } from '../search/load-options.js';
import { stripResolvedFileMentionContext } from '@garcon/server-agent-common/shared/file-mention-context';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  searchBatchLimitReached,
  searchBatchWouldExceed,
  throwIfSearchLoadAborted,
} from '@garcon/server-agent-common/shared/search-transcript-batches';

type DirectSource = Extract<DetachedTranscriptSource, { kind: 'direct-jsonl' }>;

export async function* loadDirectSearchTranscript(
  source: DirectSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  let messages: ChatMessage[] = [];
  let scanned = 0;
  let batchBytes = 0;
  for await (const line of readJsonlLineEntries(source.nativePath, {
    maxLineBytes: SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
    signal: options.signal,
  })) {
    throwIfSearchLoadAborted(options.signal);
    const lineBytes = Buffer.byteLength(line.line);
    if (searchBatchWouldExceed(scanned, batchBytes, lineBytes, options.batchSize)) {
      yield messages;
      messages = [];
      scanned = 0;
      batchBytes = 0;
    }
    try {
      const entry = JSON.parse(line.line) as { role?: unknown; content?: unknown; timestamp?: unknown };
      if (typeof entry.content === 'string') {
        const timestamp = typeof entry.timestamp === 'string'
          ? entry.timestamp
          : new Date(0).toISOString();
        if (entry.role === 'user') {
          messages.push(new UserMessage(timestamp, stripResolvedFileMentionContext(entry.content)));
        } else if (entry.role === 'assistant') {
          messages.push(new AssistantMessage(timestamp, entry.content));
        }
      }
    } catch {
      // Malformed persisted lines remain omitted like the display loader.
    }
    scanned += 1;
    batchBytes += lineBytes;
    if (!searchBatchLimitReached(scanned, batchBytes, options.batchSize)) continue;
    yield messages;
    messages = [];
    scanned = 0;
    batchBytes = 0;
  }
  throwIfSearchLoadAborted(options.signal);
  if (messages.length > 0) yield messages;
}

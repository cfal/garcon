import type { ChatMessage } from '@garcon/common/chat-types';
import type { DetachedTranscriptSource } from '@garcon/server-agent-common/search/source-types';
import type { SearchTranscriptLoadOptions } from '@garcon/server-agent-common/search/load-options';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  searchBatchLimitReached,
  searchBatchWouldExceed,
  throwIfSearchLoadAborted,
} from '@garcon/server-agent-common/shared/search-transcript-batches';
import {
  loadFactoryChatMessagesFromEvents,
  type FactoryStoredEvent,
  type FactoryStoredEventWithSource,
} from './history-loader.js';

type FactorySource = Extract<DetachedTranscriptSource, { kind: 'factory-jsonl' }>;

export async function* loadFactorySearchTranscript(
  source: FactorySource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  let events: FactoryStoredEventWithSource[] = [];
  let scanned = 0;
  let batchBytes = 0;
  for await (const line of readJsonlLineEntries(source.nativePath, {
    maxLineBytes: SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
    signal: options.signal,
  })) {
    throwIfSearchLoadAborted(options.signal);
    const lineBytes = Buffer.byteLength(line.line);
    if (searchBatchWouldExceed(scanned, batchBytes, lineBytes, options.batchSize)) {
      yield loadFactoryChatMessagesFromEvents(events);
      events = [];
      scanned = 0;
      batchBytes = 0;
    }
    try {
      const event = JSON.parse(line.line) as FactoryStoredEvent;
      if (event && typeof event === 'object' && typeof event.type === 'string') {
        events.push({
          event,
          source: {
            ...(event.type === 'session_start' && event.id ? { entryId: event.id } : {}),
            lineNumber: line.lineNumber,
            byteOffset: line.byteOffset,
          },
        });
      }
    } catch {
      // Malformed persisted lines remain omitted like the display loader.
    }
    scanned += 1;
    batchBytes += lineBytes;
    if (!searchBatchLimitReached(scanned, batchBytes, options.batchSize)) continue;
    yield loadFactoryChatMessagesFromEvents(events);
    events = [];
    scanned = 0;
    batchBytes = 0;
  }
  throwIfSearchLoadAborted(options.signal);
  if (events.length > 0) yield loadFactoryChatMessagesFromEvents(events);
}

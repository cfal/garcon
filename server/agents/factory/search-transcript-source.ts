import type { ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import { throwIfSearchLoadAborted } from '../shared/search-transcript-batches.js';
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
  for await (const line of readJsonlLineEntries(source.nativePath)) {
    throwIfSearchLoadAborted(options.signal);
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
    if (scanned % options.batchSize !== 0) continue;
    yield loadFactoryChatMessagesFromEvents(events);
    events = [];
  }
  throwIfSearchLoadAborted(options.signal);
  if (events.length > 0) yield loadFactoryChatMessagesFromEvents(events);
}

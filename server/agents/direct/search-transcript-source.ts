import { AssistantMessage, UserMessage, type ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { stripResolvedFileMentionContext } from '../shared/file-mention-context.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import { throwIfSearchLoadAborted } from '../shared/search-transcript-batches.js';

type DirectSource = Extract<DetachedTranscriptSource, { kind: 'direct-jsonl' }>;

export async function* loadDirectSearchTranscript(
  source: DirectSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  let messages: ChatMessage[] = [];
  let scanned = 0;
  for await (const line of readJsonlLineEntries(source.nativePath)) {
    throwIfSearchLoadAborted(options.signal);
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
    if (scanned % options.batchSize !== 0) continue;
    yield messages;
    messages = [];
  }
  throwIfSearchLoadAborted(options.signal);
  if (messages.length > 0) yield messages;
}

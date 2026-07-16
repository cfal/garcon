import type { ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import { throwIfSearchLoadAborted } from '../shared/search-transcript-batches.js';
import {
  addCodexJsonlLine,
  createCodexMessageBuckets,
  sortChatMessagesByTimestamp,
} from './history-loader.js';

type CodexSource = Extract<DetachedTranscriptSource, { kind: 'codex-jsonl' }>;

export async function* loadCodexSearchTranscript(
  source: CodexSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const canonical = { user: false, assistant: false, thinking: false };
  let scanned = 0;
  for await (const entry of readJsonlLineEntries(source.nativePath)) {
    throwIfSearchLoadAborted(options.signal);
    const buckets = createCodexMessageBuckets();
    addCodexJsonlLine(buckets, entry.line, {
      sourceByteOffset: entry.byteOffset,
      sourceLineNumber: entry.lineNumber,
    });
    canonical.user ||= buckets.hasCanonicalUser;
    canonical.assistant ||= buckets.hasCanonicalAssistant;
    canonical.thinking ||= buckets.hasCanonicalThinking;
    scanned += 1;
    if (scanned % options.batchSize === 0) yield [];
  }

  let messages: ChatMessage[] = [];
  scanned = 0;
  for await (const entry of readJsonlLineEntries(source.nativePath)) {
    throwIfSearchLoadAborted(options.signal);
    const buckets = createCodexMessageBuckets();
    addCodexJsonlLine(buckets, entry.line, {
      sourceByteOffset: entry.byteOffset,
      sourceLineNumber: entry.lineNumber,
    });
    messages.push(...buckets.canonical);
    if (!canonical.user) messages.push(...buckets.fallbackUser);
    if (!canonical.assistant) messages.push(...buckets.fallbackAssistant);
    if (!canonical.thinking) messages.push(...buckets.fallbackThinking);
    scanned += 1;
    if (scanned % options.batchSize !== 0) continue;
    yield sortChatMessagesByTimestamp(messages);
    messages = [];
  }
  throwIfSearchLoadAborted(options.signal);
  if (messages.length > 0) yield sortChatMessagesByTimestamp(messages);
}

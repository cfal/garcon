import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import { throwIfSearchLoadAborted } from '../shared/search-transcript-batches.js';
import {
  convertClaudeEntries,
  parseClaudeJsonlEntryWithSource,
  sortClaudeEntries,
} from './history-loader.js';

type ClaudeSource = Extract<DetachedTranscriptSource, { kind: 'claude-jsonl' }>;

export async function* loadClaudeSearchTranscript(
  source: ClaudeSource,
  options: SearchTranscriptLoadOptions,
) {
  let entries: Record<string, unknown>[] = [];
  for await (const line of readJsonlLineEntries(source.nativePath)) {
    throwIfSearchLoadAborted(options.signal);
    const entry = parseClaudeJsonlEntryWithSource(line.line, line.lineNumber ?? 1);
    if (entry) entries.push(entry);
    if ((line.lineNumber ?? entries.length) % options.batchSize !== 0) continue;
    const batch = convertClaudeEntries(sortClaudeEntries(entries));
    entries = [];
    yield batch;
  }
  throwIfSearchLoadAborted(options.signal);
  const batch = convertClaudeEntries(sortClaudeEntries(entries));
  if (batch.length > 0) yield batch;
}

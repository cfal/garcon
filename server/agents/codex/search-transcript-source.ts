import { parseChatMessage, type ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { readJsonlLineEntries } from '../shared/history-loader-utils.ts';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  boundedSearchPageSize,
  searchBatchLimitReached,
  searchBatchWouldExceed,
  throwIfSearchLoadAborted,
} from '../shared/search-transcript-batches.js';
import { createSearchTranscriptScratch } from '../shared/search-transcript-scratch.js';
import { transcriptTimestampSortFields } from '../shared/transcript-order.js';
import {
  addCodexJsonlLine,
  createCodexMessageBuckets,
} from './history-loader.js';

type CodexSource = Extract<DetachedTranscriptSource, { kind: 'codex-jsonl' }>;

export async function* loadCodexSearchTranscript(
  source: CodexSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const scratch = await createSearchTranscriptScratch(options.scratchDirectory, 'codex-');
  const bucketNames = [
    'canonical',
    'fallbackUser',
    'fallbackAssistant',
    'fallbackThinking',
  ] as const;
  const counts: Record<(typeof bucketNames)[number], number> = {
    canonical: 0,
    fallbackUser: 0,
    fallbackAssistant: 0,
    fallbackThinking: 0,
  };
  const canonical = { user: false, assistant: false, thinking: false };
  try {
    scratch.db.exec(`
      CREATE TABLE messages (
        bucket TEXT NOT NULL,
        bucket_order INTEGER NOT NULL,
        timestamp_valid INTEGER NOT NULL,
        timestamp_ms REAL NOT NULL,
        source_order INTEGER,
        json TEXT NOT NULL
      ) STRICT
    `);
    const insert = scratch.db.query(`
      INSERT INTO messages (
        bucket, bucket_order, timestamp_valid, timestamp_ms, source_order, json
      ) VALUES (?, ?, ?, ?, NULL, ?)
    `);
    let pending: Array<{
      bucket: (typeof bucketNames)[number];
      bucketOrder: number;
      message: ChatMessage;
    }> = [];
    let pendingBytes = 0;
    const flush = (): void => {
      scratch.db.transaction((rows: typeof pending) => {
        for (const row of rows) {
          const timestamp = transcriptTimestampSortFields(row.message.timestamp);
          insert.run(
            row.bucket,
            row.bucketOrder,
            timestamp.valid,
            timestamp.milliseconds,
            JSON.stringify(row.message),
          );
        }
      })(pending);
      pending = [];
      pendingBytes = 0;
    };

    let batchRecords = 0;
    for await (const entry of readJsonlLineEntries(source.nativePath, {
      maxLineBytes: SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
      signal: options.signal,
    })) {
      throwIfSearchLoadAborted(options.signal);
      const lineBytes = Buffer.byteLength(entry.line);
      if (searchBatchWouldExceed(batchRecords, pendingBytes, lineBytes, options.batchSize)) {
        flush();
        batchRecords = 0;
        yield [];
      }
      const buckets = createCodexMessageBuckets();
      addCodexJsonlLine(buckets, entry.line, {
        sourceByteOffset: entry.byteOffset,
        sourceLineNumber: entry.lineNumber,
      });
      canonical.user ||= buckets.hasCanonicalUser;
      canonical.assistant ||= buckets.hasCanonicalAssistant;
      canonical.thinking ||= buckets.hasCanonicalThinking;
      for (const bucket of bucketNames) {
        for (const message of buckets[bucket]) {
          pending.push({ bucket, bucketOrder: counts[bucket]++, message });
        }
      }
      batchRecords += 1;
      pendingBytes += lineBytes;
      if (!searchBatchLimitReached(batchRecords, pendingBytes, options.batchSize)) continue;
      flush();
      batchRecords = 0;
      yield [];
    }
    if (pending.length > 0) flush();

    const included = [
      'canonical',
      ...(!canonical.user ? ['fallbackUser'] as const : []),
      ...(!canonical.assistant ? ['fallbackAssistant'] as const : []),
      ...(!canonical.thinking ? ['fallbackThinking'] as const : []),
    ] as const;
    let sourceOffset = 0;
    for (const bucket of included) {
      scratch.db.query(`
        UPDATE messages SET source_order = bucket_order + ? WHERE bucket = ?
      `).run(sourceOffset, bucket);
      sourceOffset += counts[bucket];
    }
    scratch.db.exec(`
      CREATE TABLE ordered_messages AS
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY timestamp_valid DESC, timestamp_ms, source_order
        ) AS ordinal,
        json
      FROM messages
      WHERE source_order IS NOT NULL;
      CREATE UNIQUE INDEX ordered_messages_ordinal_idx ON ordered_messages(ordinal)
    `);
    const maxStoredBytes = Number(scratch.db.query<{ bytes: number | null }, []>(`
      SELECT MAX(length(CAST(json AS BLOB))) AS bytes FROM ordered_messages
    `).get()?.bytes ?? 0);
    const pageSize = boundedSearchPageSize(maxStoredBytes, options.batchSize);
    const page = scratch.db.query<{ ordinal: number; json: string }, [number, number]>(`
      SELECT ordinal, json FROM ordered_messages
      WHERE ordinal > ? ORDER BY ordinal LIMIT ?
    `);
    let lastOrdinal = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const rows = page.all(lastOrdinal, pageSize);
      if (rows.length === 0) return;
      const messages: ChatMessage[] = [];
      for (const row of rows) {
        lastOrdinal = Number(row.ordinal);
        const raw = JSON.parse(row.json) as Record<string, unknown>;
        const message = parseChatMessage(raw);
        if (message) messages.push(message);
      }
      yield messages;
    }
  } finally {
    await scratch.close();
  }
}

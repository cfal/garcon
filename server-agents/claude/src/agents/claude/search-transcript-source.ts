import type { ChatMessage } from '@garcon/common/chat-types';
import type { DetachedTranscriptSource } from '@garcon/server-agent-common/search/source-types';
import type { SearchTranscriptLoadOptions } from '@garcon/server-agent-common/search/load-options';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  boundedSearchPageSize,
  searchBatchLimitReached,
  searchBatchWouldExceed,
  throwIfSearchLoadAborted,
} from '@garcon/server-agent-common/shared/search-transcript-batches';
import { createSearchTranscriptScratch } from '@garcon/server-agent-common/shared/search-transcript-scratch';
import { transcriptTimestampSortFields } from '@garcon/server-agent-common/shared/transcript-order';
import {
  convertClaudeEntries,
  parseClaudeJsonlEntryWithSource,
} from './history-loader.js';

type ClaudeSource = Extract<DetachedTranscriptSource, { kind: 'claude-jsonl' }>;

interface StoredClaudeEntry {
  sourceOrder: number;
  timestampValid: 0 | 1;
  timestampMs: number;
  lineNumber: number;
  json: string;
  isBoundary: 0 | 1;
  isSummary: 0 | 1;
}

function restoreEntry(json: string, lineNumber: number): Record<string, unknown> {
  const entry = JSON.parse(json) as Record<string, unknown>;
  const entryId = typeof entry.uuid === 'string' && entry.uuid
    ? entry.uuid
    : typeof entry.id === 'string' && entry.id
      ? entry.id
      : typeof entry.messageId === 'string' && entry.messageId
        ? entry.messageId
        : undefined;
  return attachNativeMessageSource(entry, { lineNumber, ...(entryId ? { entryId } : {}) });
}

export async function* loadClaudeSearchTranscript(
  source: ClaudeSource,
  options: SearchTranscriptLoadOptions,
) {
  const scratch = await createSearchTranscriptScratch(options.scratchDirectory, 'claude-');
  try {
    scratch.db.exec(`
      CREATE TABLE entries (
        source_order INTEGER PRIMARY KEY,
        timestamp_valid INTEGER NOT NULL,
        timestamp_ms REAL NOT NULL,
        line_number INTEGER NOT NULL,
        json TEXT NOT NULL,
        is_boundary INTEGER NOT NULL,
        is_summary INTEGER NOT NULL
      ) STRICT
    `);
    const insert = scratch.db.query(`
      INSERT INTO entries (
        source_order, timestamp_valid, timestamp_ms, line_number,
        json, is_boundary, is_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let pending: StoredClaudeEntry[] = [];
    let pendingBytes = 0;
    const flush = (): void => {
      scratch.db.transaction((rows: StoredClaudeEntry[]) => {
        for (const row of rows) {
          insert.run(
            row.sourceOrder,
            row.timestampValid,
            row.timestampMs,
            row.lineNumber,
            row.json,
            row.isBoundary,
            row.isSummary,
          );
        }
      })(pending);
      pending = [];
      pendingBytes = 0;
    };
    let sourceOrder = 0;
    let scanned = 0;
    let batchRecords = 0;
    for await (const line of readJsonlLineEntries(source.nativePath, {
      maxLineBytes: SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
      signal: options.signal,
    })) {
      throwIfSearchLoadAborted(options.signal);
      const lineBytes = Buffer.byteLength(line.line);
      if (searchBatchWouldExceed(batchRecords, pendingBytes, lineBytes, options.batchSize)) {
        flush();
        batchRecords = 0;
        yield [];
      }
      const lineNumber = line.lineNumber ?? scanned + 1;
      const entry = parseClaudeJsonlEntryWithSource(line.line, lineNumber);
      if (entry) {
        const timestamp = transcriptTimestampSortFields(
          typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
        );
        pending.push({
          sourceOrder: sourceOrder++,
          timestampValid: timestamp.valid,
          timestampMs: timestamp.milliseconds,
          lineNumber,
          json: JSON.stringify(entry),
          isBoundary: entry.type === 'system' && entry.subtype === 'compact_boundary' ? 1 : 0,
          isSummary: entry.isCompactSummary === true ? 1 : 0,
        });
      }
      scanned += 1;
      batchRecords += 1;
      pendingBytes += lineBytes;
      if (!searchBatchLimitReached(batchRecords, pendingBytes, options.batchSize)) continue;
      flush();
      batchRecords = 0;
      yield [];
    }
    if (pending.length > 0) flush();

    scratch.db.exec(`
      CREATE TABLE ordered_entries AS
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY timestamp_valid DESC, timestamp_ms, source_order
        ) AS ordinal,
        SUM(is_summary) OVER (
          ORDER BY timestamp_valid DESC, timestamp_ms, source_order
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) - 1 AS summary_rank,
        line_number,
        json,
        is_summary
      FROM entries;
      CREATE UNIQUE INDEX ordered_entries_ordinal_idx ON ordered_entries(ordinal);
      CREATE TABLE ordered_boundaries AS
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY timestamp_valid DESC, timestamp_ms, source_order
        ) - 1 AS boundary_rank,
        line_number,
        json
      FROM entries
      WHERE is_boundary = 1;
      CREATE UNIQUE INDEX ordered_boundaries_rank_idx ON ordered_boundaries(boundary_rank)
    `);
    const maxStoredBytes = Number(scratch.db.query<{ bytes: number | null }, []>(`
      SELECT MAX(length(CAST(json AS BLOB))) AS bytes FROM entries
    `).get()?.bytes ?? 0);
    const pageSize = boundedSearchPageSize(maxStoredBytes * 2, options.batchSize);
    const page = scratch.db.query<{
      ordinal: number;
      lineNumber: number;
      json: string;
      isSummary: number;
      boundaryLineNumber: number | null;
      boundaryJson: string | null;
    }, [number, number]>(`
      SELECT
        entries.ordinal,
        entries.line_number AS lineNumber,
        entries.json,
        entries.is_summary AS isSummary,
        boundaries.line_number AS boundaryLineNumber,
        boundaries.json AS boundaryJson
      FROM ordered_entries entries
      LEFT JOIN ordered_boundaries boundaries
        ON entries.is_summary = 1 AND boundaries.boundary_rank = entries.summary_rank
      WHERE entries.ordinal > ?
      ORDER BY entries.ordinal
      LIMIT ?
    `);
    let lastOrdinal = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const rows = page.all(lastOrdinal, pageSize);
      if (rows.length === 0) return;
      const messages: ChatMessage[] = [];
      for (const row of rows) {
        lastOrdinal = Number(row.ordinal);
        const entry = restoreEntry(row.json, Number(row.lineNumber));
        if (row.isSummary && row.boundaryJson && row.boundaryLineNumber) {
          const boundary = restoreEntry(row.boundaryJson, Number(row.boundaryLineNumber));
          messages.push(...convertClaudeEntries([boundary, entry]));
        } else {
          messages.push(...convertClaudeEntries([entry]));
        }
      }
      yield messages;
    }
  } finally {
    await scratch.close();
  }
}

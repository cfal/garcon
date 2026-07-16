import type { ChatMessage } from '../../../common/chat-types.js';
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
import { convertPiMessage } from './message-converter.js';

type PiSource = Extract<DetachedTranscriptSource, { kind: 'pi-jsonl' }>;

interface StoredEntryRow {
  id: string;
  parentId: string | null;
  sourceOrder: number;
  json: string;
}

interface PathRow {
  depth: number;
  json: string;
}

function parseEntry(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function* loadPiSearchTranscript(
  source: PiSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const scratch = await createSearchTranscriptScratch(options.scratchDirectory, 'pi-');
  const db = scratch.db;
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        source_order INTEGER NOT NULL,
        json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE active_path (
        depth INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        json TEXT NOT NULL
      ) STRICT;
    `);
    const insert = db.query(`
      INSERT OR REPLACE INTO entries (id, parent_id, source_order, json)
      VALUES (?, ?, ?, ?)
    `);
    let pending: StoredEntryRow[] = [];
    let pendingBytes = 0;
    let batchRecords = 0;
    const flushPending = (): void => {
      if (pending.length > 0) {
        db.transaction((rows: StoredEntryRow[]) => {
          for (const row of rows) insert.run(row.id, row.parentId, row.sourceOrder, row.json);
        })(pending);
      }
      pending = [];
      pendingBytes = 0;
    };
    let sourceOrder = 0;
    for await (const line of readJsonlLineEntries(source.nativePath, {
      maxLineBytes: SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
      signal: options.signal,
    })) {
      throwIfSearchLoadAborted(options.signal);
      const lineBytes = Buffer.byteLength(line.line);
      if (searchBatchWouldExceed(batchRecords, pendingBytes, lineBytes, options.batchSize)) {
        flushPending();
        batchRecords = 0;
        yield [];
      }
      const entry = parseEntry(line.line);
      if (entry && entry.type !== 'session') {
        sourceOrder += 1;
        const id = typeof entry.id === 'string' && entry.id
          ? entry.id
          : `legacy-${sourceOrder}`;
        const parentId = typeof entry.parentId === 'string'
          ? entry.parentId
          : null;
        entry.id = id;
        entry.parentId = parentId;
        pending.push({ id, parentId, sourceOrder, json: JSON.stringify(entry) });
      }
      batchRecords += 1;
      pendingBytes += lineBytes;
      if (!searchBatchLimitReached(batchRecords, pendingBytes, options.batchSize)) continue;
      flushPending();
      batchRecords = 0;
      yield [];
    }
    if (pending.length > 0) flushPending();

    const leaf = db.query<StoredEntryRow, []>(`
      SELECT id, parent_id AS parentId, source_order AS sourceOrder, json
      FROM entries ORDER BY source_order DESC LIMIT 1
    `).get();
    const findEntry = db.query<StoredEntryRow, [string]>(`
      SELECT id, parent_id AS parentId, source_order AS sourceOrder, json
      FROM entries WHERE id = ?
    `);
    const insertPath = db.query('INSERT OR IGNORE INTO active_path (depth, id, json) VALUES (?, ?, ?)');
    let current = leaf;
    let depth = 0;
    while (current) {
      throwIfSearchLoadAborted(options.signal);
      if (insertPath.run(depth, current.id, current.json).changes === 0) {
        throw new Error('Pi transcript parent graph contains a cycle');
      }
      depth += 1;
      current = current.parentId ? findEntry.get(current.parentId) : null;
      if (depth % options.batchSize === 0) yield [];
    }

    const compaction = db.query<{ depth: number; firstKeptEntryId: string | null }, []>(`
      SELECT
        depth,
        json_extract(json, '$.firstKeptEntryId') AS firstKeptEntryId
      FROM active_path
      WHERE json_extract(json, '$.type') = 'compaction'
      ORDER BY depth ASC
      LIMIT 1
    `).get();
    const firstKeptDepth = compaction?.firstKeptEntryId
      ? db.query<{ depth: number }, [string]>(`
          SELECT depth FROM active_path WHERE id = ?
        `).get(compaction.firstKeptEntryId)?.depth ?? null
      : null;
    const maxStoredBytes = Number(db.query<{ bytes: number | null }, []>(`
      SELECT MAX(length(CAST(json AS BLOB))) AS bytes FROM active_path
    `).get()?.bytes ?? 0);
    const pageSize = boundedSearchPageSize(maxStoredBytes, options.batchSize);
    const messagePage = db.query<PathRow, [number, number, number, number, number, number]>(`
      SELECT depth, json
      FROM active_path
      WHERE depth < ?
        AND json_extract(json, '$.type') = 'message'
        AND (
          ? < 0
          OR depth < ?
          OR (? >= 0 AND depth > ? AND depth <= ?)
      )
      ORDER BY depth DESC
      LIMIT ${pageSize}
    `);
    let beforeDepth = Number.MAX_SAFE_INTEGER;
    const compactionDepth = compaction?.depth ?? -1;
    const keptDepth = firstKeptDepth ?? -1;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const rows = messagePage.all(
        beforeDepth,
        compactionDepth,
        compactionDepth,
        keptDepth,
        compactionDepth,
        keptDepth,
      );
      if (rows.length === 0) return;
      const messages: ChatMessage[] = [];
      for (const row of rows) {
        beforeDepth = Math.min(beforeDepth, Number(row.depth));
        const entry = parseEntry(row.json);
        if (entry) messages.push(...convertPiMessage(entry.message));
      }
      yield messages;
    }
  } finally {
    await scratch.close();
  }
}

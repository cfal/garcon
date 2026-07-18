import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { stat } from 'node:fs/promises';
import type { ChatMessage } from '../../../common/chat-types.js';
import { hasNodeErrorCode } from '../../lib/errors.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import {
  SEARCH_TRANSCRIPT_MAX_RECORD_BYTES,
  boundedSearchPageSize,
  throwIfSearchLoadAborted,
} from '../shared/search-transcript-batches.js';
import { createSearchTranscriptScratch } from '../shared/search-transcript-scratch.js';
import {
  cursorStoreDbPath,
  normalizeCursorBlobs,
  type CursorDbBlob,
  type CursorMessageBlob,
} from './history-loader.js';

type CursorSource = Extract<DetachedTranscriptSource, { kind: 'cursor-acp' }>;

interface BlobIdentityRow {
  rowid: number;
  id: string;
}

interface OrderedBlobRow extends BlobIdentityRow {
  orderIndex: number;
}

async function cursorFileFingerprint(filePath: string, required: boolean): Promise<string> {
  try {
    const file = await stat(filePath, { bigint: true });
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  } catch (error) {
    if (!required && hasNodeErrorCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

function toBuffer(value: Uint8Array | Buffer | null | undefined): Buffer | null {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export async function probeCursorDatabase(storePath: string): Promise<string> {
  const identity = createHash('sha256').update(storePath).digest('hex');
  const [database, wal] = await Promise.all([
    cursorFileFingerprint(storePath, true),
    cursorFileFingerprint(`${storePath}-wal`, false),
  ]);
  return `cursor-acp:${identity}:db:${database}:wal:${wal}`;
}

export async function probeCursorSearchTranscript(source: CursorSource): Promise<string> {
  return probeCursorDatabase(cursorStoreDbPath(source.sessionId, source.projectPath));
}

export async function* loadCursorSearchTranscriptFromPath(
  storePath: string,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const sourceDb = new Database(storePath, { readonly: true, create: false });
  const scratch = await createSearchTranscriptScratch(options.scratchDirectory, 'cursor-');
  try {
    const largestRecord = sourceDb.query<{ id: string; size: number }, []>(`
      SELECT id, length(data) AS size FROM blobs ORDER BY length(data) DESC LIMIT 1
    `).get();
    if (largestRecord && largestRecord.size > SEARCH_TRANSCRIPT_MAX_RECORD_BYTES) {
      throw new Error(`Cursor transcript record exceeds ${SEARCH_TRANSCRIPT_MAX_RECORD_BYTES} bytes`);
    }
    const sourcePageSize = boundedSearchPageSize(largestRecord?.size ?? 0, options.batchSize);
    scratch.db.exec(`
      CREATE TABLE blob_meta (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        is_json INTEGER NOT NULL,
        id_bytes BLOB NOT NULL
      ) STRICT;
      CREATE TABLE raw_parent_refs (
        node_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        parent_order INTEGER NOT NULL,
        PRIMARY KEY (node_id, parent_order)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE parent_refs (
        node_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        parent_order INTEGER NOT NULL,
        PRIMARY KEY (node_id, parent_order)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX parent_refs_parent_idx ON parent_refs(parent_id);
      CREATE TABLE visited (id TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
      CREATE TABLE ordered_blobs (
        order_index INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE message_order (
        id TEXT PRIMARY KEY,
        order_index INTEGER NOT NULL UNIQUE
      ) WITHOUT ROWID, STRICT
    `);
    const sourcePage = sourceDb.query<CursorDbBlob, [number, number]>(`
      SELECT rowid, id, data FROM blobs WHERE rowid > ? ORDER BY rowid LIMIT ?
    `);
    const insertMeta = scratch.db.query(`
      INSERT INTO blob_meta (rowid, id, is_json, id_bytes) VALUES (?, ?, ?, ?)
    `);
    const insertRawParent = scratch.db.query(`
      INSERT OR IGNORE INTO raw_parent_refs (node_id, parent_id, parent_order) VALUES (?, ?, ?)
    `);
    let lastSourceRowId = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const blobs = sourcePage.all(lastSourceRowId, sourcePageSize);
      if (blobs.length === 0) break;
      scratch.db.transaction((rows: CursorDbBlob[]) => {
        for (const blob of rows) {
          lastSourceRowId = Math.max(lastSourceRowId, Number(blob.rowid));
          const data = toBuffer(blob.data) ?? Buffer.alloc(0);
          const isJson = data[0] === 0x7b;
          insertMeta.run(blob.rowid, blob.id, isJson ? 1 : 0, Buffer.from(blob.id, 'hex'));
          if (isJson) continue;
          let parentOrder = 0;
          for (let index = 0; index < data.length - 33; index += 1) {
            if (data[index] !== 0x0a || data[index + 1] !== 0x20) continue;
            insertRawParent.run(blob.id, data.subarray(index + 2, index + 34).toString('hex'), parentOrder++);
            index += 33;
          }
        }
      })(blobs);
      yield [];
    }
    scratch.db.exec(`
      INSERT INTO parent_refs (node_id, parent_id, parent_order)
      SELECT raw.node_id, raw.parent_id, raw.parent_order
      FROM raw_parent_refs raw
      JOIN blob_meta parent ON parent.id = raw.parent_id
    `);

    const isVisited = scratch.db.query<{ found: number }, [string]>(`
      SELECT 1 AS found FROM visited WHERE id = ?
    `);
    const markVisited = scratch.db.query('INSERT INTO visited (id) VALUES (?)');
    const parentsFor = scratch.db.query<{ parentId: string }, [string]>(`
      SELECT parent_id AS parentId FROM parent_refs WHERE node_id = ? ORDER BY parent_order
    `);
    const insertOrdered = scratch.db.query('INSERT INTO ordered_blobs (order_index, id) VALUES (?, ?)');
    let orderedIndex = 0;
    let traversalOperations = 0;
    const visit = async function* (startId: string): AsyncGenerator<ChatMessage[]> {
      const stack: Array<{ id: string; expanded: boolean }> = [{ id: startId, expanded: false }];
      while (stack.length > 0) {
        throwIfSearchLoadAborted(options.signal);
        const frame = stack.pop();
        if (!frame) break;
        if (frame.expanded) {
          insertOrdered.run(orderedIndex++, frame.id);
        } else {
          if (isVisited.get(frame.id)) continue;
          markVisited.run(frame.id);
          stack.push({ id: frame.id, expanded: true });
          const parents = parentsFor.all(frame.id);
          for (let index = parents.length - 1; index >= 0; index -= 1) {
            stack.push({ id: parents[index].parentId, expanded: false });
          }
        }
        traversalOperations += 1;
        if (traversalOperations % options.batchSize === 0) yield [];
      }
    };
    const rootsPage = scratch.db.query<BlobIdentityRow, [number, number]>(`
      SELECT meta.rowid, meta.id
      FROM blob_meta meta
      WHERE meta.rowid > ?
        AND NOT EXISTS (SELECT 1 FROM parent_refs refs WHERE refs.node_id = meta.id)
      ORDER BY meta.rowid
      LIMIT ?
    `);
    const allIdsPage = scratch.db.query<BlobIdentityRow, [number, number]>(`
      SELECT rowid, id FROM blob_meta WHERE rowid > ? ORDER BY rowid LIMIT ?
    `);
    for (const page of [rootsPage, allIdsPage]) {
      let lastRowId = 0;
      while (true) {
        const rows = page.all(lastRowId, options.batchSize);
        if (rows.length === 0) break;
        for (const row of rows) {
          lastRowId = Number(row.rowid);
          yield* visit(row.id);
        }
      }
    }

    const orderedBinaryPage = scratch.db.query<OrderedBlobRow, [number, number]>(`
      SELECT ordered.order_index AS orderIndex, meta.rowid, meta.id
      FROM ordered_blobs ordered
      JOIN blob_meta meta ON meta.id = ordered.id
      WHERE ordered.order_index > ? AND meta.is_json = 0
      ORDER BY ordered.order_index
      LIMIT ?
    `);
    const sourceData = sourceDb.query<{ data: Uint8Array | Buffer | null }, [string]>(`
      SELECT data FROM blobs WHERE id = ?
    `);
    const referencedJsonIds = scratch.db.query<{ id: string }, [Buffer]>(`
      SELECT id FROM blob_meta
      WHERE is_json = 1 AND instr(?, id_bytes) > 0
      ORDER BY rowid
    `);
    const insertMessageOrder = scratch.db.query(`
      INSERT OR IGNORE INTO message_order (id, order_index) VALUES (?, ?)
    `);
    let lastOrderedIndex = -1;
    let messageOrderIndex = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const rows = orderedBinaryPage.all(lastOrderedIndex, options.batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        lastOrderedIndex = Number(row.orderIndex);
        const data = toBuffer(sourceData.get(row.id)?.data);
        if (!data) continue;
        for (const match of referencedJsonIds.all(data)) {
          const result = insertMessageOrder.run(match.id, messageOrderIndex);
          if (result.changes > 0) messageOrderIndex += 1;
        }
      }
      yield [];
    }
    scratch.db.exec(`
      CREATE TABLE ordered_messages AS
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(message_order.order_index, 9223372036854775807), meta.rowid
        ) AS ordinal,
        meta.rowid,
        meta.id
      FROM blob_meta meta
      LEFT JOIN message_order ON message_order.id = meta.id
      WHERE meta.is_json = 1;
      CREATE UNIQUE INDEX ordered_messages_ordinal_idx ON ordered_messages(ordinal)
    `);
    const orderedMessagesPage = scratch.db.query<BlobIdentityRow & { ordinal: number }, [number, number]>(`
      SELECT ordinal, rowid, id FROM ordered_messages
      WHERE ordinal > ? ORDER BY ordinal LIMIT ?
    `);
    const sourceJson = sourceDb.query<{ data: Uint8Array | Buffer | null }, [number]>(`
      SELECT data FROM blobs WHERE rowid = ?
    `);
    let lastOrdinal = 0;
    let sequence = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const rows = orderedMessagesPage.all(lastOrdinal, sourcePageSize);
      if (rows.length === 0) return;
      const normalized: CursorMessageBlob[] = [];
      for (const row of rows) {
        lastOrdinal = Number(row.ordinal);
        const data = toBuffer(sourceJson.get(row.rowid)?.data);
        if (!data) continue;
        try {
          const content = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
          const nested = content.message && typeof content.message === 'object'
            ? content.message as Record<string, unknown>
            : {};
          if ((content.role ?? nested.role) === 'system') continue;
          sequence += 1;
          normalized.push({ id: row.id, rowid: row.rowid, sequence, content });
        } catch {
          // Cursor stores non-message JSON fragments in the same blob table.
        }
      }
      yield normalizeCursorBlobs(normalized);
    }
  } finally {
    sourceDb.close();
    await scratch.close();
  }
}

export async function* loadCursorSearchTranscript(
  source: CursorSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  yield* loadCursorSearchTranscriptFromPath(
    cursorStoreDbPath(source.sessionId, source.projectPath),
    options,
  );
}

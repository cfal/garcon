import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { stat } from 'node:fs/promises';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { DetachedTranscriptSource } from '../../chats/search/source-types.js';
import type { SearchTranscriptLoadOptions } from '../search-transcript-loader.js';
import { throwIfSearchLoadAborted } from '../shared/search-transcript-batches.js';
import {
  cursorStoreDbPath,
  normalizeCursorBlobs,
  type CursorDbBlob,
  type CursorMessageBlob,
} from './history-loader.js';

type CursorSource = Extract<DetachedTranscriptSource, { kind: 'cursor-acp' }>;

export async function probeCursorSearchTranscript(source: CursorSource): Promise<string> {
  const storePath = cursorStoreDbPath(source.sessionId, source.projectPath);
  const file = await stat(storePath);
  const identity = createHash('sha256').update(storePath).digest('hex');
  return `cursor-acp:${identity}:${file.size}:${Math.trunc(file.mtimeMs)}`;
}

function toBuffer(value: Uint8Array | Buffer | null | undefined): Buffer | null {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export async function* loadCursorSearchTranscript(
  source: CursorSource,
  options: SearchTranscriptLoadOptions,
): AsyncGenerator<ChatMessage[]> {
  const db = new Database(cursorStoreDbPath(source.sessionId, source.projectPath), {
    readonly: true,
    create: false,
  });
  try {
    const page = db.query<CursorDbBlob, [number, number]>(`
      SELECT rowid, id, data
      FROM blobs
      WHERE rowid > ? AND substr(data, 1, 1) = x'7B'
      ORDER BY rowid
      LIMIT ?
    `);
    let lastRowId = 0;
    let sequence = 0;
    while (true) {
      throwIfSearchLoadAborted(options.signal);
      const blobs = page.all(lastRowId, options.batchSize);
      if (blobs.length === 0) return;
      const normalized: CursorMessageBlob[] = [];
      for (const blob of blobs) {
        lastRowId = Math.max(lastRowId, Number(blob.rowid));
        const data = toBuffer(blob.data);
        if (!data) continue;
        try {
          const content = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
          const nested = content.message && typeof content.message === 'object'
            ? content.message as Record<string, unknown>
            : {};
          if ((content.role ?? nested.role) === 'system') continue;
          sequence += 1;
          normalized.push({
            id: blob.id,
            rowid: blob.rowid,
            sequence,
            content,
          });
        } catch {
          // Cursor stores non-message JSON fragments in the same blob table.
        }
      }
      yield normalizeCursorBlobs(normalized);
    }
  } finally {
    db.close();
  }
}

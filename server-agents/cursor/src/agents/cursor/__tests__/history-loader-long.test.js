import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeCursorBlobs, readCursorBlobs } from '../history-loader.js';

// Long enough that reading it in one pass would hold the event loop well past the limit.
const TURNS = 1000;
const MAX_GAP_MS = 50;

function blobId(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Each graph node names its parent node and the message it adds, as Cursor's store does.
function writeSyntheticStore(storeDbPath) {
  const db = new Database(storeDbPath);
  try {
    db.query('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)').run();
    const insert = db.query('INSERT INTO blobs (id, data) VALUES (?, ?)');
    db.transaction(() => {
      let parentId = null;
      for (let turn = 0; turn < TURNS; turn += 1) {
        const message = Buffer.from(JSON.stringify({
          role: turn % 2 === 0 ? 'user' : 'assistant',
          content: `Synthetic message ${turn} ${'generic words '.repeat(10)}`,
        }));
        const messageId = blobId(message);
        insert.run(messageId, message);
        const node = Buffer.concat([
          Buffer.from([1]),
          ...(parentId ? [Buffer.from([0x0a, 0x20]), Buffer.from(parentId, 'hex')] : []),
          Buffer.from([0x12, 0x20]),
          Buffer.from(messageId, 'hex'),
        ]);
        parentId = blobId(node);
        insert.run(parentId, node);
      }
    })();
  } finally {
    db.close();
  }
}

describe('long Cursor sessions', () => {
  it('read every message in graph order without holding the event loop for the whole store', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-long-history-'));
    const storeDbPath = path.join(directory, 'store.db');
    writeSyntheticStore(storeDbPath);
    try {
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 1);
      const messages = await normalizeCursorBlobs(await readCursorBlobs(storeDbPath));
      // A final synchronous stretch ends before the probe runs again, so it gets one more turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      clearInterval(probe);

      expect(messages).toHaveLength(TURNS);
      expect(messages[0].content).toStartWith('Synthetic message 0 ');
      expect(messages.at(-1).content).toStartWith(`Synthetic message ${TURNS - 1} `);
      expect(longestGap).toBeLessThan(MAX_GAP_MS);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

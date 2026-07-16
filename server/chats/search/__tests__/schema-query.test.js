import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendChatRows,
  deleteChatRows,
  openSearchDatabase,
  replaceChatRows,
} from '../schema.js';
import { searchTranscriptIndex } from '../query.js';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function openDatabase() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-v3-'));
  return openSearchDatabase(path.join(tempDir, 'chat-search-v3.sqlite'));
}

describe('transcript search v3 schema and query', () => {
  it('configures secure v3 external-content FTS storage on every open', async () => {
    const opened = await openDatabase();
    const dbPath = opened.dbPath;
    expect(opened.db.query('PRAGMA user_version').get().user_version).toBe(3);
    expect(opened.db.query('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(opened.db.query('PRAGMA secure_delete').get().secure_delete).toBe(1);
    expect(opened.db.query('PRAGMA auto_vacuum').get().auto_vacuum).toBe(2);
    expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    opened.db.close();

    const reopened = await openSearchDatabase(dbPath);
    expect(reopened.db.query('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(reopened.db.query('PRAGMA secure_delete').get().secure_delete).toBe(1);
    reopened.db.close();
  });

  it('matches AND terms across messages and phrases within one message', async () => {
    const { db } = await openDatabase();
    replaceChatRows(db, 'c1', 10, 'fixture:sha256:a', [
      { messageOrdinal: 1, role: 'user', timestamp: null, body: 'alpha request exact phrase' },
      { messageOrdinal: 2, role: 'assistant', timestamp: null, body: 'beta response' },
    ]);
    replaceChatRows(db, 'c2', 10, 'fixture:sha256:b', [
      { messageOrdinal: 1, role: 'user', timestamp: null, body: 'alpha exact' },
      { messageOrdinal: 2, role: 'assistant', timestamp: null, body: 'phrase only' },
    ]);

    const across = searchTranscriptIndex(db, {
      query: 'alpha beta',
      allowedChatIds: ['c1', 'c2'],
    });
    expect(across.results.map((row) => row.chatId)).toEqual(['c1']);
    expect(across.results[0].matchedMessageCount).toBe(2);

    const phrase = searchTranscriptIndex(db, {
      query: '"exact phrase"',
      allowedChatIds: ['c1', 'c2'],
    });
    expect(phrase.results.map((row) => row.chatId)).toEqual(['c1']);
    expect(phrase.results[0].snippets[0].text).toContain('exact phrase');
    db.close();
  });

  it('uses the chat ordinal index for append and physically removes deleted chats', async () => {
    const opened = await openDatabase();
    let { db } = opened;
    const { dbPath } = opened;
    appendChatRows(db, 'deleted', 20, [
      { role: 'assistant', timestamp: null, body: 'uniquedeletiontoken' },
    ]);
    const plan = db.query(`
      EXPLAIN QUERY PLAN
      SELECT MAX(message_ordinal)
      FROM search_chunks INDEXED BY search_chunks_chat_ordinal_idx
      WHERE chat_id = 'deleted'
    `).all().map((row) => row.detail).join(' ');
    expect(plan).toContain('search_chunks_chat_ordinal_idx');
    expect(searchTranscriptIndex(db, {
      query: 'uniquedeletiontoken',
      allowedChatIds: ['deleted'],
    }).results).toHaveLength(1);

    db = deleteChatRows(db, 'deleted');
    expect(db.query('SELECT COUNT(*) AS count FROM search_chunks WHERE chat_id = ?').get('deleted').count).toBe(0);
    expect(searchTranscriptIndex(db, {
      query: 'uniquedeletiontoken',
      allowedChatIds: ['deleted'],
    }).results).toEqual([]);
    expect(() => db.exec("INSERT INTO search_chunks_fts(search_chunks_fts) VALUES ('integrity-check')")).not.toThrow();
    db.close();

    const walPath = `${dbPath}-wal`;
    const walSize = await stat(walPath).then((entry) => entry.size).catch(() => 0);
    expect(walSize).toBe(0);
    const reopened = new Database(dbPath);
    expect(reopened.query("SELECT COUNT(*) AS count FROM search_chunks_fts WHERE search_chunks_fts MATCH 'uniquedeletiontoken'").get().count).toBe(0);
    reopened.close();
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendChatRows,
  deleteChatRows,
  closeSearchDatabase,
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
      { messageOrdinal: 3, role: 'assistant', timestamp: null, body: 'exact exact exact without the other word' },
    ]);
    replaceChatRows(db, 'c2', 10, 'fixture:sha256:b', [
      { messageOrdinal: 1, role: 'user', timestamp: null, body: 'alpha exact' },
      { messageOrdinal: 2, role: 'assistant', timestamp: null, body: 'phrase only' },
    ]);
    replaceChatRows(db, 'c3', 10, 'fixture:sha256:c', [
      { messageOrdinal: 1, role: 'assistant', timestamp: null, body: 'Meet at the caf\u00e9' },
    ]);

    const across = searchTranscriptIndex(db, {
      query: 'alpha beta',
      allowedChatIds: ['c1', 'c2'],
    });
    expect(across.results.map((row) => row.chatId)).toEqual(['c1']);
    expect(across.results[0].matchedMessageCount).toBe(2);

    const phrase = searchTranscriptIndex(db, {
      query: '"exact phrase"',
      textTokens: ['exact phrase'],
      allowedChatIds: ['c1', 'c2'],
    });
    expect(phrase.results.map((row) => row.chatId)).toEqual(['c1']);
    expect(phrase.results[0].snippets[0].text).toContain('exact phrase');
    expect(phrase.results[0].matchedMessageCount).toBe(1);
    const snippetPlanStatement = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT snippet(search_chunks_fts, 0, '', '', ' ... ', 32)
      FROM temp_search_snippet_candidates candidates
      CROSS JOIN search_chunks_fts
        ON search_chunks_fts.rowid = candidates.row_id
      WHERE search_chunks_fts MATCH ?
    `);
    const snippetPlan = snippetPlanStatement.all('("exact phrase")');
    snippetPlanStatement.finalize();
    expect(snippetPlan[0].detail).toContain('candidates');
    expect(snippetPlan[1].detail).toContain('INDEX 0:=M1');

    const diacritic = searchTranscriptIndex(db, {
      query: 'cafe',
      allowedChatIds: ['c3'],
    });
    expect(diacritic.results.map((row) => row.chatId)).toEqual(['c3']);
    expect(diacritic.results[0].snippets[0].text).toContain('caf\u00e9');
    closeSearchDatabase(db);
  });

  it('uses BM25 ranking for single terms instead of insertion order', async () => {
    const { db } = await openDatabase();
    replaceChatRows(db, 'weak', 1, 'fixture:weak', [
      { messageOrdinal: 1, role: 'user', timestamp: null, body: 'deploy filler filler filler filler' },
    ]);
    replaceChatRows(db, 'strong', 1, 'fixture:strong', [
      { messageOrdinal: 1, role: 'user', timestamp: null, body: 'deploy deploy deploy deploy' },
    ]);
    const result = searchTranscriptIndex(db, {
      query: 'deploy',
      allowedChatIds: ['weak', 'strong'],
      limit: 1,
    });
    expect(result.results.map((row) => row.chatId)).toEqual(['strong']);
    db.close();
  });

  it('recreates a corrupt derived database and records clean shutdowns', async () => {
    const opened = await openDatabase();
    const { dbPath } = opened;
    closeSearchDatabase(opened.db);
    const clean = await openSearchDatabase(dbPath);
    expect(clean.recreated).toBe(false);
    closeSearchDatabase(clean.db);

    await writeFile(dbPath, 'not a sqlite database');
    const recovered = await openSearchDatabase(dbPath);
    expect(recovered.recreated).toBe(true);
    expect(recovered.db.query('PRAGMA user_version').get().user_version).toBe(3);
    closeSearchDatabase(recovered.db);
  });

  it('uses the chat ordinal index for append and physically removes deleted chats', async () => {
    const opened = await openDatabase();
    let { db } = opened;
    const { dbPath } = opened;
    appendChatRows(db, 'deleted', 20, [
      { role: 'assistant', timestamp: null, body: 'uniquedeletiontoken' },
    ]);
    const planStatement = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT MAX(message_ordinal)
      FROM search_chunks INDEXED BY search_chunks_chat_ordinal_idx
      WHERE chat_id = 'deleted'
    `);
    const plan = planStatement.all().map((row) => row.detail).join(' ');
    planStatement.finalize();
    expect(plan).toContain('search_chunks_chat_ordinal_idx');
    expect(searchTranscriptIndex(db, {
      query: 'uniquedeletiontoken',
      allowedChatIds: ['deleted'],
    }).results).toHaveLength(1);

    const connection = db;
    db = await deleteChatRows(db, 'deleted');
    expect(db).toBe(connection);
    expect(db.query('SELECT COUNT(*) AS count FROM search_chunks WHERE chat_id = ?').get('deleted').count).toBe(0);
    expect(searchTranscriptIndex(db, {
      query: 'uniquedeletiontoken',
      allowedChatIds: ['deleted'],
    }).results).toEqual([]);
    expect(() => db.exec("INSERT INTO search_chunks_fts(search_chunks_fts) VALUES ('integrity-check')")).not.toThrow();
    closeSearchDatabase(db);

    const walPath = `${dbPath}-wal`;
    const walSize = await stat(walPath).then((entry) => entry.size).catch(() => 0);
    expect(walSize).toBe(0);
    const reopened = new Database(dbPath);
    expect(reopened.query("SELECT COUNT(*) AS count FROM search_chunks_fts WHERE search_chunks_fts MATCH 'uniquedeletiontoken'").get().count).toBe(0);
    reopened.close();
    expect((await readFile(dbPath)).includes(Buffer.from('uniquedeletiontoken'))).toBe(false);
  });
});

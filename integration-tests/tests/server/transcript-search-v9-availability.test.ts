import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptSearchStatusResponse } from '../../../common/chat-search.js';
import {
  SEARCH_CORPUS_TIER_S,
  bulkAppendCorpusRows,
  createSearchCorpusChats,
  readDerivedIndexSnapshot,
} from '../../support/search-corpus-fixture.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

const INDEX_DIRECTORY = 'transcript-search';

async function installStaleDerivedIndex(workspaceDir: string, version: 7 | 8): Promise<void> {
  const directory = join(workspaceDir, INDEX_DIRECTORY);
  const path = join(directory, 'index.sqlite');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec('CREATE TABLE stale_search_marker(value TEXT)');
  } finally {
    db.close();
  }
}

describe('transcript search v9 availability', () => {
  test('[TLV5-SEARCH.03-SERVER-01] builds, searches, restarts idempotently, and prunes', async () => {
    await withIntegrationFixture('transcript-search-v9-availability', async (fixture) => {
      const corpus = await createSearchCorpusChats(fixture, SEARCH_CORPUS_TIER_S);
      await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
      await fixture.restartGarcon({
        beforeStart: async () => {
          await bulkAppendCorpusRows(fixture.dirs.workspace, corpus, SEARCH_CORPUS_TIER_S);
          await rm(join(fixture.dirs.workspace, INDEX_DIRECTORY), { recursive: true, force: true });
        },
      });

      const ready = await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 60_000 });
      expect(ready.chats.failed).toBe(0);
      const result = await fixture.client.waitForChatSearch(
        { query: corpus.markerTerm, limit: 20 },
        (response) => response.index.pendingChatCount === 0
          && response.results.some((entry) => entry.chatId === corpus.denseChatIds[0]),
        { timeoutMs: 30_000 },
      );
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((entry) => corpus.denseChatIds.includes(entry.chatId))).toBe(true);

      const before = readDerivedIndexSnapshot(fixture.dirs.workspace);
      expect(before.userVersion).toBe(9);
      await fixture.restartGarcon();
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 5_000 });
      const after = readDerivedIndexSnapshot(fixture.dirs.workspace);
      expect(after.stateStamps).toEqual(before.stateStamps);
      expect(after.maxChunkId).toBe(before.maxChunkId);
      expect(after.chunkCount).toBe(before.chunkCount);

      const deletedChatId = corpus.denseChatIds.at(-1)!;
      await fixture.client.deleteChat(deletedChatId);
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 30_000 });
      const pruned = await fixture.client.searchChats({ query: corpus.markerTerm, limit: 20 });
      expect(pruned.results.some((entry) => entry.chatId === deletedChatId)).toBe(false);
      const indexPath = join(fixture.dirs.workspace, INDEX_DIRECTORY, 'index.sqlite');
      const db = new Database(indexPath, { readonly: true });
      try {
        const count = db.query('SELECT COUNT(*) AS n FROM search_chunks WHERE chat_id = ?')
          .get(deletedChatId) as { n: number };
        expect(count.n).toBe(0);
      } finally {
        db.close();
      }
      await expect(stat(join(
        fixture.dirs.workspace,
        'transcript-ledgers',
        deletedChatId,
      ))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 120_000);

  test('[TLV5-SEARCH.10-SERVER-01] discards v7/v8 files and recreates corrupt v9 files', async () => {
    await withIntegrationFixture('transcript-search-v9-recreation', async (fixture) => {
      const corpus = await createSearchCorpusChats(fixture, {
        ...SEARCH_CORPUS_TIER_S,
        denseChats: 1,
        denseRowsPerChat: 20,
        maxChatRows: 20,
        sparseChats: 0,
      });
      await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });

      for (const version of [7, 8] as const) {
        await fixture.restartGarcon({
          beforeStart: async () => installStaleDerivedIndex(fixture.dirs.workspace, version),
        });
        await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 30_000 });
        const snapshot = readDerivedIndexSnapshot(fixture.dirs.workspace);
        expect(snapshot.userVersion).toBe(9);
        const found = await fixture.client.searchChats({
          query: corpus.markerTerm,
          chatIds: [...corpus.denseChatIds],
        });
        expect(found.results.map((entry) => entry.chatId)).toEqual([...corpus.denseChatIds]);
      }

      const indexPath = join(fixture.dirs.workspace, INDEX_DIRECTORY, 'index.sqlite');
      await fixture.restartGarcon({
        beforeStart: async () => {
          const file = await open(indexPath, 'r+');
          try {
            await file.write(Buffer.alloc(512), 0, 512, 0);
          } finally {
            await file.close();
          }
        },
      });
      await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 30_000 });
      expect(readDerivedIndexSnapshot(fixture.dirs.workspace).userVersion).toBe(9);
      const recovered = await fixture.client.searchChats({
        query: corpus.markerTerm,
        chatIds: [...corpus.denseChatIds],
      });
      expect(recovered.results.map((entry) => entry.chatId)).toEqual([...corpus.denseChatIds]);
    });
  }, 120_000);

  test('[TLV5-SEARCH.09-SERVER-01] reports the disabled HTTP contract', async () => {
    await withIntegrationFixture('transcript-search-v9-disabled', async (fixture) => {
      const status = await fixture.client.get<TranscriptSearchStatusResponse>(
        '/api/v1/chats/search/status',
      );
      expect(status.phase).toBe('disabled');
      expect(status.chats).toEqual({
        total: 0,
        indexed: 0,
        pending: 0,
        failed: 0,
        unindexed: 0,
      });

      const search = await fixture.client.timedSearchChats({ query: 'syntheticmarker' });
      expect(search.status).toBe(409);
      expect(search.body.errorCode).toBe('TRANSCRIPT_SEARCH_DISABLED');
    });
  });
});

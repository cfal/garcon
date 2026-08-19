import { expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { ChatSearchResult } from '../../../common/chat-search.js';
import type { ChatMessagesPage } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

const TEST_TIMEOUT_MS = 120_000;

test('[TLV5-SEARCH.03-RESTORE-SERVER-01] recreates a stale derived index and restores search without provider reads', async () => {
  await withIntegrationFixture('transcript-search-v8-recovery', async (fixture) => {
    const sparseChatId = fixture.newChatId();
    const denseChatId = fixture.newChatId();
    const term = `recovery${crypto.randomUUID().replaceAll('-', '')}`;
    const sparseTranscript = await completeChat(fixture, sparseChatId, term);
    const denseTranscript = await completeChat(
      fixture,
      denseChatId,
      `${term} ${term} ${term}`,
    );

    const settings = await fixture.client.updateSettings({
      features: { transcriptSearch: { enabled: true } },
    });
    expect(settings.settings.features.transcriptSearch.enabled).toBe(true);
    const providerRequestCount = fixture.fakeProviders.openAi.requests().length;
    const indexPath = join(fixture.dirs.workspace, 'transcript-search', 'index.sqlite');

    await fixture.restartGarcon({
      beforeStart: () => installStaleV7Index(indexPath),
    });

    const restored = await fixture.client.waitForChatSearch(
      { query: term, chatIds: [sparseChatId, denseChatId], limit: 20 },
      (response) => response.index.pendingChatCount === 0
        && response.results.length === 2,
      { timeoutMs: 30_000 },
    );
    expect(restored.index).toEqual({
      indexedChatCount: 2,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    expect(restored.results.map((result) => result.chatId)).toEqual([
      denseChatId,
      sparseChatId,
    ]);
    expect(restored.results[0]!.score).toBeGreaterThan(restored.results[1]!.score);
    expectSearchResult(restored.results[0]!, denseTranscript, term);
    expectSearchResult(restored.results[1]!, sparseTranscript, term);
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount);
    expectV8RelationalSchema(indexPath);

    await fixture.client.deleteChat(denseChatId);
    const pruned = await fixture.client.waitForChatSearch(
      { query: term, chatIds: [sparseChatId, denseChatId], limit: 20 },
      (response) => response.index.pendingChatCount === 0
        && response.index.indexedChatCount === 1
        && response.results.length === 1,
      { timeoutMs: 30_000 },
    );
    expect(pruned.results.map((result) => result.chatId)).toEqual([sparseChatId]);

    await fixture.restartGarcon();
    const reopened = await fixture.client.waitForChatSearch(
      { query: term, chatIds: [sparseChatId, denseChatId], limit: 20 },
      (response) => response.index.pendingChatCount === 0
        && response.index.indexedChatCount === 1,
      { timeoutMs: 30_000 },
    );
    expect(reopened.results.map((result) => result.chatId)).toEqual([sparseChatId]);
    expectSearchResult(reopened.results[0]!, sparseTranscript, term);
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(providerRequestCount);
    expectV8RelationalSchema(indexPath);
  });
}, TEST_TIMEOUT_MS);

async function completeChat(
  fixture: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<ChatMessagesPage> {
  const turn = await fixture.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.dirs.project,
    agent: fixture.directAgents.openAi,
  });
  expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId)).type)
    .toBe('agent-run-finished');
  return fixture.client.getMessages(chatId);
}

async function installStaleV7Index(indexPath: string): Promise<void> {
  const directory = dirname(indexPath);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const database = new Database(indexPath, { create: true, strict: true });
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE stale_search_marker(value TEXT NOT NULL) STRICT;
      INSERT INTO stale_search_marker VALUES ('synthetic-v7-derived-data');
      PRAGMA user_version = 7;
    `);
  } finally {
    database.close();
  }
}

function expectSearchResult(
  result: ChatSearchResult,
  transcript: ChatMessagesPage,
  term: string,
): void {
  expect(result.transcriptViewId).toBe(transcript.transcriptViewId);
  expect(result.snippets.length).toBeGreaterThan(0);
  const transcriptOrdinals = new Set(transcript.messages.map((entry) => entry.ordinal));
  expect(result.snippets.every((snippet) => transcriptOrdinals.has(snippet.ordinal))).toBe(true);
  expect(result.snippets.some((snippet) => snippet.text.includes(term))).toBe(true);
}

function expectV8RelationalSchema(indexPath: string): void {
  const database = new Database(indexPath, { readonly: true, strict: true });
  try {
    expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE name IN ('stale_search_marker', 'search_chunks_fts')
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE name IN (
        'search_chat_state',
        'search_chunks',
        'search_chunk_progress',
        'search_chunk_terms',
        'search_corpus_stats',
        'search_index_metadata'
      )
    `).get()).toEqual({ count: 6 });
  } finally {
    database.close();
  }
}

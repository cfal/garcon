import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileChatSearchQuery } from '@garcon/common/chat-search';
import { UserMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '../message-projector.js';
import {
  finishChatSync,
  insertRowsBatch,
  openSearchDatabase,
  planChatSync,
} from '../schema.js';
import type { ReaderEvent, ReaderRequest } from '../worker-protocol.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function post(worker: Worker, request: ReaderRequest): void {
  worker.postMessage(request);
}

describe('reader worker v9', () => {
  test('searches NUL and unpaired-surrogate literals without reporting an internal failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-reader-nul-'));
    directories.push(directory);
    const dbPath = join(directory, 'index.sqlite');
    const { db } = await openSearchDatabase(dbPath);
    const chatId = 'chat-nul';
    const transcriptViewId = 'view-nul';
    planChatSync(db, {
      mode: 'replace', chatId, transcriptViewId, targetThrough: 1, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId, transcriptViewId, advanceTo: 1,
      rows: [{
        ordinal: 1, role: 'user', timestamp: null,
        body: projectSearchMessage(new UserMessage('', 'foo\u0000bar marker'))!.body,
      }],
    });
    finishChatSync(db, { chatId, transcriptViewId });
    db.close();

    const worker = new Worker(new URL('../reader-main.ts', import.meta.url).href);
    const lifecycleEpoch = 'epoch-nul';
    const nextEvent = () => new Promise<ReaderEvent>((resolve) => {
      worker.addEventListener('message', (event: MessageEvent<ReaderEvent>) => resolve(event.data), { once: true });
    });
    try {
      let event = nextEvent();
      post(worker, { type: 'open', requestId: 1, lifecycleEpoch, dbPath });
      expect(await event).toMatchObject({ type: 'opened' });
      for (const [index, { query, expectedChatIds }] of [
        { query: 'foo\u0000bar', expectedChatIds: [chatId] },
        { query: 'foo\ud800bar', expectedChatIds: [] },
        { query: 'foo\udc00bar', expectedChatIds: [] },
        { query: '#731\ud800', expectedChatIds: [] },
        { query: '#731\udc00', expectedChatIds: [] },
        { query: 'marker', expectedChatIds: [chatId] },
      ].entries()) {
        event = nextEvent();
        const requestId = index + 2;
        post(worker, {
          type: 'search-start', requestId, lifecycleEpoch,
          query: compileChatSearchQuery(query), order: 'allowlist', mode: 'page',
          offset: 0, limit: 20, snippetLimit: 1,
        });
        post(worker, {
          type: 'search-allowlist-chunk', requestId, lifecycleEpoch, chunkIndex: 0, done: true,
          allowedChats: [{ chatId, transcriptViewId, throughOrdinal: 1 }],
        });
        const result = await event;
        expect(result).toMatchObject({ type: 'search-result', requestId });
        expect(result.type === 'search-result' && result.results.map((hit) => hit.chatId))
          .toEqual(expectedChatIds);
      }
    } finally {
      await worker.terminate();
    }
  });

  test('[TLV5-SEARCH.08-READER-01] searches and cooperatively exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'search-v9-reader-'));
    directories.push(directory);
    const dbPath = join(directory, 'index.sqlite');
    const opened = await openSearchDatabase(dbPath);
    planChatSync(opened.db, {
      mode: 'replace',
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      targetThrough: 1,
      expectedAfterOrdinal: 0,
    });
    insertRowsBatch(opened.db, {
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      rows: [{
        ordinal: 1,
        role: 'user',
        timestamp: null,
        body: 'synthetic reader marker',
      }],
      advanceTo: 1,
    });
    finishChatSync(opened.db, { chatId: 'chat-0001', transcriptViewId: 'view-0001' });
    planChatSync(opened.db, {
      mode: 'replace',
      chatId: 'chat-2001',
      transcriptViewId: 'view-2001',
      targetThrough: 1,
      expectedAfterOrdinal: 0,
    });
    insertRowsBatch(opened.db, {
      chatId: 'chat-2001',
      transcriptViewId: 'view-2001',
      rows: [{
        ordinal: 1,
        role: 'user',
        timestamp: null,
        body: 'synthetic reader marker',
      }],
      advanceTo: 1,
    });
    finishChatSync(opened.db, { chatId: 'chat-2001', transcriptViewId: 'view-2001' });
    opened.db.close();

    const worker = new Worker(new URL('../reader-main.ts', import.meta.url).href);
    const events: ReaderEvent[] = [];
    let notify = () => {};
    worker.onmessage = (message: MessageEvent<ReaderEvent>) => {
      events.push(message.data);
      notify();
    };
    const waitForEvent = async (type: ReaderEvent['type']): Promise<ReaderEvent> => {
      while (true) {
        const found = events.find((event) => event.type === type);
        if (found) return found;
        await new Promise<void>((resolve) => { notify = resolve; });
      }
    };
    const closed = new Promise<void>((resolve) => {
      worker.addEventListener('close', () => resolve(), { once: true });
    });
    const lifecycleEpoch = 'epoch-reader-0001';
    post(worker, { type: 'open', requestId: 1, lifecycleEpoch, dbPath });
    const openedEvent = await waitForEvent('opened');
    expect(openedEvent).toMatchObject({ type: 'opened' });
    post(worker, {
      type: 'search-start',
      requestId: 2,
      lifecycleEpoch,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'marker', normalized: 'marker', match: 'exact' }],
        }],
      },
      order: 'allowlist',
      mode: 'page',
      offset: 0,
      limit: 2,
      snippetLimit: 3,
    });
    post(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 0,
      allowedChats: [
        { chatId: 'chat-2001', transcriptViewId: 'view-2001', throughOrdinal: 1 },
        ...Array.from({ length: 1_999 }, (_, index) => ({
          chatId: `dummy-${String(index).padStart(4, '0')}`,
          transcriptViewId: `dummy-view-${index}`,
          throughOrdinal: 0,
        })),
      ],
      done: false,
    });
    post(worker, {
      type: 'search-allowlist-chunk',
      requestId: 2,
      lifecycleEpoch,
      chunkIndex: 1,
      allowedChats: [{
        chatId: 'chat-0001',
        transcriptViewId: 'view-0001',
        throughOrdinal: 1,
      }],
      done: true,
    });
    const result = await waitForEvent('search-result');
    expect(result).toMatchObject({ type: 'search-result' });
    expect(result.type === 'search-result' && result.results.map((entry) => entry.chatId))
      .toEqual(['chat-2001', 'chat-0001']);

    post(worker, { type: 'close', requestId: 3, lifecycleEpoch });
    const closedEvent = await waitForEvent('closed');
    expect(closedEvent).toMatchObject({ type: 'closed' });
    await closed;
  });
});

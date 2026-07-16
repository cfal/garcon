import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  AssistantMessage,
  BashToolUseMessage,
  ExecToolUseMessage,
  UserMessage,
  WaitToolUseMessage,
} from '../../../common/chat-types.js';
import { ChatSearchIndex } from '../chat-search-index.js';

let tempDir;

function registry(sessions) {
  return {
    listAllChats: mock(() => sessions),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await delay(5);
  }
}

describe('ChatSearchIndex', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-chat-search-'));
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createIndex(messagesByChatId = {}) {
    const index = new ChatSearchIndex({
      dbPath: path.join(tempDir, 'search.sqlite'),
      registry: registry({
        c1: {
          agentId: 'claude',
          agentSessionId: 's1',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'sonnet',
        },
        c2: {
          agentId: 'codex',
          agentSessionId: 's2',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'gpt',
        },
      }),
      loadNativeMessages: mock(async (chatId) => messagesByChatId[chatId] ?? []),
      now: () => new Date('2026-07-08T00:00:00.000Z'),
    });
    await index.init();
    return index;
  }

  it('indexes normalized chat messages and returns snippets by allowed chat', async () => {
    const index = await createIndex({
      c1: [
        new UserMessage('2026-07-08T00:00:00.000Z', 'How do we rotate deployment tokens?'),
        new AssistantMessage('2026-07-08T00:01:00.000Z', 'Use the needle rotation runbook.'),
      ],
      c2: [new AssistantMessage('2026-07-08T00:00:00.000Z', 'needle belongs to another chat')],
    });

    await index.reindexStaleChats();
    const result = index.search({
      query: 'needle',
      allowedChatIds: ['c1'],
      limit: 10,
    });

    expect(result.results.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(result.results[0].snippets[0].text).toContain('needle rotation runbook');
    expect(result.index).toEqual({ indexedChatCount: 1, pendingChatCount: 0 });
  });

  it('appends live tool messages and deletes removed chats', async () => {
    const index = await createIndex();
    index.appendMessages('c1', [
      new BashToolUseMessage('2026-07-08T00:00:00.000Z', 'tool-1', 'rg superneedle .'),
    ]);

    expect(index.search({ query: 'superneedle', allowedChatIds: ['c1'] }).results).toHaveLength(1);

    index.deleteChat('c1');
    expect(index.search({ query: 'superneedle', allowedChatIds: ['c1'] }).results).toEqual([]);
  });

  it('bounds overlapping reindex work and converges from source after activity settles', async () => {
    const firstLoad = deferred();
    const loadStarted = deferred();
    const historical = new UserMessage(
      '2026-07-08T00:00:00.000Z',
      'historical-bootstrap-term',
    );
    const live = new AssistantMessage(
      '2026-07-08T00:01:00.000Z',
      'live-append-term',
    );
    const sourceMessages = [historical];
    const loadNativeMessages = mock(async () => {
      if (loadNativeMessages.mock.calls.length === 1) {
        loadStarted.resolve();
        return firstLoad.promise;
      }
      return [...sourceMessages];
    });
    const index = new ChatSearchIndex({
      dbPath: path.join(tempDir, 'search.sqlite'),
      registry: registry({
        c1: {
          agentId: 'claude',
          agentSessionId: 's1',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'sonnet',
        },
      }),
      loadNativeMessages,
      reindexDebounceMs: 30,
    });
    await index.init();
    index.replaceMessages('c1', [
      new AssistantMessage('2026-07-07T00:00:00.000Z', 'stale-index-term'),
    ]);

    const reindexing = index.reindexStaleChats();
    await loadStarted.promise;
    expect(index.indexStatus(['c1'])).toEqual({ indexedChatCount: 0, pendingChatCount: 1 });

    sourceMessages.push(live);
    index.appendMessages('c1', [live]);
    expect(index.indexStatus(['c1'])).toEqual({ indexedChatCount: 0, pendingChatCount: 1 });
    firstLoad.resolve([historical]);
    await reindexing;

    expect(loadNativeMessages).toHaveBeenCalledTimes(1);
    expect(index.search({ query: 'stale-index-term', allowedChatIds: ['c1'] }).results).toHaveLength(1);
    expect(index.search({ query: 'live-append-term', allowedChatIds: ['c1'] }).results).toHaveLength(1);
    expect(index.indexStatus(['c1'])).toEqual({ indexedChatCount: 0, pendingChatCount: 1 });

    for (let activity = 0; activity < 6; activity += 1) {
      const message = new AssistantMessage(
        `2026-07-08T00:02:0${activity}.000Z`,
        `bounded-activity-${activity}`,
      );
      sourceMessages.push(message);
      index.appendMessages('c1', [message]);
      await delay(5);
      expect(loadNativeMessages).toHaveBeenCalledTimes(1);
    }

    await waitFor(() => loadNativeMessages.mock.calls.length === 2);
    await waitFor(() => index.indexStatus(['c1']).pendingChatCount === 0);
    expect(loadNativeMessages).toHaveBeenCalledTimes(2);
    const combined = index.search({
      query: 'historical-bootstrap-term live-append-term bounded-activity-5',
      allowedChatIds: ['c1'],
    });
    expect(combined.results.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(combined.index).toEqual({ indexedChatCount: 1, pendingChatCount: 0 });
  });

  it('cancels a pending retry when the chat is deleted', async () => {
    const firstLoad = deferred();
    const loadStarted = deferred();
    const loadNativeMessages = mock(async () => {
      loadStarted.resolve();
      return firstLoad.promise;
    });
    const index = new ChatSearchIndex({
      dbPath: path.join(tempDir, 'search.sqlite'),
      registry: registry({
        c1: {
          agentId: 'claude',
          agentSessionId: 's1',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'sonnet',
        },
      }),
      loadNativeMessages,
      reindexDebounceMs: 20,
    });
    await index.init();

    const reindexing = index.reindexStaleChats();
    await loadStarted.promise;
    index.appendMessages('c1', [
      new AssistantMessage('2026-07-08T00:01:00.000Z', 'deleted-live-term'),
    ]);
    firstLoad.resolve([]);
    await reindexing;
    index.deleteChat('c1');
    await delay(40);

    expect(loadNativeMessages).toHaveBeenCalledTimes(1);
    expect(index.search({ query: 'deleted-live-term', allowedChatIds: ['c1'] }).results).toEqual([]);
  });

  it('does not overwrite an authoritative reload with an older startup snapshot', async () => {
    const firstLoad = deferred();
    const loadStarted = deferred();
    const index = new ChatSearchIndex({
      dbPath: path.join(tempDir, 'search.sqlite'),
      registry: registry({
        c1: {
          agentId: 'claude',
          agentSessionId: 's1',
          nativePath: null,
          projectPath: '/tmp/project',
          tags: [],
          model: 'sonnet',
        },
      }),
      loadNativeMessages: async () => {
        loadStarted.resolve();
        return firstLoad.promise;
      },
    });
    await index.init();

    const reindexing = index.reindexStaleChats();
    await loadStarted.promise;
    index.replaceMessages('c1', [
      new AssistantMessage('2026-07-08T00:01:00.000Z', 'authoritative-reload-term'),
    ]);
    firstLoad.resolve([
      new UserMessage('2026-07-08T00:00:00.000Z', 'older-bootstrap-term'),
    ]);
    await reindexing;

    expect(index.search({ query: 'authoritative-reload-term', allowedChatIds: ['c1'] }).results)
      .toHaveLength(1);
    expect(index.search({ query: 'older-bootstrap-term', allowedChatIds: ['c1'] }).results)
      .toEqual([]);
    expect(index.indexStatus(['c1'])).toEqual({ indexedChatCount: 1, pendingChatCount: 0 });
  });

  it('matches query terms across messages and returns representative snippets', async () => {
    const index = await createIndex({
      c1: [
        new UserMessage('2026-07-08T00:00:00.000Z', 'alpha appears in this request'),
        new AssistantMessage('2026-07-08T00:01:00.000Z', 'beta appears in this response'),
      ],
      c2: [new AssistantMessage('2026-07-08T00:00:00.000Z', 'alpha only')],
    });
    await index.reindexStaleChats();

    const result = index.search({ query: 'alpha beta', allowedChatIds: ['c1', 'c2'] });

    expect(result.results.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(result.results[0].matchedMessageCount).toBe(2);
    expect(result.results[0].snippets.map((entry) => entry.text).join(' ')).toContain('alpha');
    expect(result.results[0].snippets.map((entry) => entry.text).join(' ')).toContain('beta');
  });

  it('ranks and limits chats before collecting snippets from verbose matches', async () => {
    const verboseMessages = Array.from(
      { length: 40 },
      (_, index) => new AssistantMessage(
        `2026-07-08T00:${String(index).padStart(2, '0')}:00.000Z`,
        `needle repeated in verbose message ${index}`,
      ),
    );
    const index = await createIndex({
      c1: verboseMessages,
      c2: [new AssistantMessage('2026-07-08T00:00:00.000Z', 'one concise needle match')],
    });
    await index.reindexStaleChats();

    const result = index.search({ query: 'needle', allowedChatIds: ['c1', 'c2'], limit: 2 });

    expect(new Set(result.results.map((entry) => entry.chatId))).toEqual(new Set(['c1', 'c2']));
    expect(result.results.find((entry) => entry.chatId === 'c1')?.snippets).toHaveLength(3);
    expect(result.results.find((entry) => entry.chatId === 'c1')?.matchedMessageCount).toBe(40);
    expect(result.results.find((entry) => entry.chatId === 'c2')?.snippets).toHaveLength(1);
  });

  it('indexes explicit exec and wait tool-use messages', async () => {
    const index = await createIndex();
    index.appendMessages('c1', [
      new ExecToolUseMessage(
        '2026-07-08T00:00:00.000Z',
        'tool-exec',
        'console.log("superexec")',
        'javascript',
      ),
      new WaitToolUseMessage(
        '2026-07-08T00:00:01.000Z',
        'tool-wait',
        'execution-superwait',
        500,
        2000,
        false,
      ),
    ]);

    expect(index.search({ query: 'superexec', allowedChatIds: ['c1'] }).results).toHaveLength(1);
    expect(index.search({ query: 'superwait', allowedChatIds: ['c1'] }).results).toHaveLength(1);
  });
});

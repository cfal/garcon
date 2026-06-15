import { describe, expect, it, mock } from 'bun:test';
import { ChatViewStore } from '../chat-view-store.js';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../../common/chat-types.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content, metadata = {}) {
  return new UserMessage(TS, content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function contents(page) {
  return page.messages.map((entry) => entry.message.content);
}

describe('ChatViewStore', () => {
  it('creates an empty generation from an empty native read', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => []);

    const page = await store.getOrCreatePage('chat-1', loadNative, 20);

    expect(page.generationId).toBeTruthy();
    expect(page.lastSeq).toBe(0);
    expect(page.messages).toEqual([]);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('creates a generation from native history and pages by seq cursor', async () => {
    const store = new ChatViewStore(() => false);
    const page = await store.getOrCreatePage(
      'chat-1',
      async () => [user('hello'), assistant('hi')],
      1,
    );

    expect(contents(page)).toEqual(['hi']);
    expect(page.lastSeq).toBe(2);
    expect(page.pageOldestSeq).toBe(2);
    expect(page.hasMore).toBe(true);

    const older = store.readPage('chat-1', 1, page.pageOldestSeq);
    expect(contents(older)).toEqual(['hello']);
    expect(older.hasMore).toBe(false);
  });

  it('replaces native generations intentionally', async () => {
    const store = new ChatViewStore(() => false);
    const first = await store.getOrCreatePage('chat-1', async () => [user('old')], 20);
    const replacement = await store.replaceFromNative('chat-1', async () => [assistant('fresh')]);

    expect(replacement.generationId).not.toBe(first.generationId);
    expect(contents(replacement)).toEqual(['fresh']);
    expect(replacement.lastSeq).toBe(1);
  });

  it('appends gap-free seq values after an atomic cold native load', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => [user('history')]);

    const appended = await store.appendAfterEnsuringGeneration('chat-1', loadNative, [
      assistant('live one'),
      assistant('live two'),
    ]);
    const page = store.readPage('chat-1', 20);

    expect(appended.messages.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(contents(page)).toEqual(['history', 'live one', 'live two']);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('does not replace an existing generation during a later get-or-create read', async () => {
    const store = new ChatViewStore(() => false);
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [assistant('live')],
    );

    const page = await store.getOrCreatePage(
      'chat-1',
      async () => [assistant('native after live')],
      20,
    );

    expect(page.generationId).toBe(appended.generationId);
    expect(contents(page)).toEqual(['live']);
  });

  it('serializes concurrent cold appends under one generation', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => [user('history')]);

    const [first, second] = await Promise.all([
      store.appendAfterEnsuringGeneration('chat-1', loadNative, [assistant('a')]),
      store.appendAfterEnsuringGeneration('chat-1', loadNative, [assistant('b')]),
    ]);
    const page = store.readPage('chat-1', 20);

    expect(first.generationId).toBe(second.generationId);
    expect(contents(page)).toEqual(['history', 'a', 'b']);
    expect(page.messages.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('replays same-generation messages after lastSeq', async () => {
    const store = new ChatViewStore(() => false);
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [user('one'), assistant('two'), assistant('three')],
    );

    const replay = store.readReplay('chat-1', appended.generationId, 1);

    expect(replay).toMatchObject({ mode: 'delta', lastSeq: 3 });
    expect(contents(replay)).toEqual(['two', 'three']);
  });

  it('requires snapshots for stale generations, ahead cursors, and oversized deltas', async () => {
    const store = new ChatViewStore(() => false, { replayLimit: 1 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [user('one'), assistant('two'), assistant('three')],
    );

    expect(store.readReplay('chat-1', 'stale-generation', 1)).toMatchObject({
      mode: 'snapshot-required',
      generationId: appended.generationId,
      lastSeq: 3,
    });
    expect(store.readReplay('chat-1', appended.generationId, 99)).toMatchObject({
      mode: 'snapshot-required',
      generationId: appended.generationId,
      lastSeq: 3,
    });
    expect(store.readReplay('chat-1', appended.generationId, 1)).toMatchObject({
      mode: 'snapshot-required',
      generationId: appended.generationId,
      lastSeq: 3,
    });
  });

  it('adds process-death notice as a normal in-memory message', async () => {
    const store = new ChatViewStore(() => false);
    const page = await store.replaceFromNative('chat-1', async () => [assistant('native')], {
      appendProcessDiedNotice: true,
    });

    expect(contents(page)).toEqual(['native', 'The process died.']);
    expect(page.messages[1].message).toBeInstanceOf(ErrorMessage);
  });

  it('eviction causes the next access to mint a new generation', async () => {
    const store = new ChatViewStore(() => false);
    const first = await store.getOrCreatePage('chat-1', async () => [assistant('old')], 20);

    store.evict('chat-1');
    const second = await store.getOrCreatePage('chat-1', async () => [assistant('new')], 20);

    expect(second.generationId).not.toBe(first.generationId);
    expect(contents(second)).toEqual(['new']);
  });

  it('drops stale stream output after a fence invalidation', async () => {
    const store = new ChatViewStore(() => false);
    const fence = store.captureFence('chat-1');

    await store.replaceFromNative('chat-1', async () => [assistant('native')]);
    store.invalidateFence('chat-1');
    const stale = await store.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [assistant('late')],
      { fence },
    );
    const page = store.readPage('chat-1', 20);

    expect(stale.skipped).toBe(true);
    expect(stale.messages).toEqual([]);
    expect(contents(page)).toEqual(['native']);
  });
});

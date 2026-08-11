import { describe, expect, it, mock } from 'bun:test';
import { ChatViewStore } from '../chat-view-store.js';
import {
  AgentSwitchMessage,
  AssistantMessage,
  CompactionMessage,
  ErrorMessage,
  UserMessage,
} from '../../../common/chat-types.js';
import { attachNativeMessageSource } from '../../agents/shared/native-message-source.js';
import {
  historyPage,
  nativeReconciliation,
  pagedTranscriptLoader,
  projectionAppender,
  snapshotLoader,
  transcriptSnapshot,
  transcriptLoader,
} from './chat-transcript-test-helpers.js';

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

function fullLoader(loadAll) {
  return transcriptLoader(loadAll);
}

function pagedLoader(historyRef) {
  return pagedTranscriptLoader(historyRef);
}

describe('ChatViewStore', () => {
  it('creates an empty generation from an empty native read', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => []);

    const page = await store.getOrCreatePage('chat-1', fullLoader(loadNative), 20);

    expect(page.generationId).toBeTruthy();
    expect(page.lastSeq).toBe(0);
    expect(page.messages).toEqual([]);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('creates a generation from native history and pages by seq cursor', async () => {
    const store = new ChatViewStore(() => false);
    const page = await store.getOrCreatePage(
      'chat-1',
      fullLoader(async () => [user('hello'), assistant('hi')]),
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
    const first = await store.getOrCreatePage('chat-1', fullLoader(async () => [user('old')]), 20);
    const replacement = await store.replaceFromNative(
      'chat-1',
      snapshotLoader(async () => [assistant('fresh')]),
    );

    expect(replacement.generationId).not.toBe(first.generationId);
    expect(contents(replacement)).toEqual(['fresh']);
    expect(replacement.lastSeq).toBe(1);
  });

  it('replays same-generation messages after lastSeq', async () => {
    const store = new ChatViewStore(() => false);
    const append = projectionAppender(store, 'chat-1');
    const appended = await append([user('one'), assistant('two'), assistant('three')]);

    const replay = store.readReplay('chat-1', appended.generationId, 1);

    expect(replay).toMatchObject({ mode: 'delta', lastSeq: 3 });
    expect(contents(replay)).toEqual(['two', 'three']);
  });

  it('requires snapshots for stale generations, ahead cursors, and oversized deltas', async () => {
    const store = new ChatViewStore(() => false, { replayLimit: 1 });
    const append = projectionAppender(store, 'chat-1');
    const appended = await append([user('one'), assistant('two'), assistant('three')]);

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

  it('appends the given process-error notice as a normal in-memory message', async () => {
    const store = new ChatViewStore(() => false);
    const page = await store.replaceFromNative('chat-1', snapshotLoader(async () => [assistant('native')]), {
      processErrorNotice: 'Codex rate limit exceeded. Please wait a moment and try again.',
    });

    expect(contents(page)).toEqual(['native', 'Codex rate limit exceeded. Please wait a moment and try again.']);
    expect(page.messages[1].message).toBeInstanceOf(ErrorMessage);
  });

  it('does not duplicate a matching native process-error row', async () => {
    const store = new ChatViewStore(() => false);
    const reason = 'Provider rejected the request.';
    const page = await store.replaceFromNative('chat-1', snapshotLoader(async () => [
      assistant('partial response'),
      new ErrorMessage(TS, reason),
    ]), { processErrorNotice: reason });

    expect(contents(page)).toEqual(['partial response', reason]);
    expect(page.messages[1].message).toBeInstanceOf(ErrorMessage);
  });

  it('eviction causes the next access to mint a new generation', async () => {
    const store = new ChatViewStore(() => false);
    const first = await store.getOrCreatePage('chat-1', fullLoader(async () => [assistant('old')]), 20);

    store.evict('chat-1');
    const second = await store.getOrCreatePage('chat-1', fullLoader(async () => [assistant('new')]), 20);

    expect(second.generationId).not.toBe(first.generationId);
    expect(contents(second)).toEqual(['new']);
  });

  it('loads and retains only requested contiguous history pages', async () => {
    const store = new ChatViewStore(() => false);
    const loadAll = mock(async () => [
      user('one'), assistant('two'), assistant('three'), assistant('four'), assistant('five'),
    ]);
    const all = await loadAll();
    loadAll.mockClear();
    const loadPage = mock(async (limit, offset) => {
      return historyPage(all, limit, offset);
    });

    const recent = await store.getOrCreatePage(
      'chat-1',
      { loadAll: snapshotLoader(loadAll), loadPage },
      2,
    );
    expect(recent.messages.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(contents(recent)).toEqual(['four', 'five']);

    const middle = await store.getOrCreatePage(
      'chat-1',
      { loadAll: snapshotLoader(loadAll), loadPage },
      2,
      4,
    );
    expect(middle.messages.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(contents(middle)).toEqual(['two', 'three']);

    const oldest = await store.getOrCreatePage(
      'chat-1',
      { loadAll: snapshotLoader(loadAll), loadPage },
      2,
      2,
    );
    expect(oldest.messages.map((entry) => entry.seq)).toEqual([1]);
    expect(oldest.hasMore).toBe(false);
    expect(loadPage.mock.calls.map((call) => call.slice(0, 2))).toEqual([[2, 0], [2, 2], [1, 4]]);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('serves non-contiguous page requests without making the retained suffix sparse', async () => {
    const store = new ChatViewStore(() => false);
    const history = Array.from({ length: 10 }, (_, index) => assistant(String(index + 1)));
    const loadPage = mock(async (limit, offset) => {
      return historyPage(history, limit, offset);
    });
    const loader = { loadAll: snapshotLoader(async () => history), loadPage };

    const recent = await store.getOrCreatePage('chat-1', loader, 2);
    const skipped = await store.getOrCreatePage('chat-1', loader, 2, 5);
    const contiguous = await store.getOrCreatePage('chat-1', loader, 2, recent.pageOldestSeq);

    expect(skipped.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contiguous.messages.map((entry) => entry.seq)).toEqual([7, 8]);
    expect(store.readPage('chat-1', 10).messages.map((entry) => entry.seq)).toEqual([7, 8, 9, 10]);
  });

  it('fills a wider latest-page request from an existing partial suffix', async () => {
    const store = new ChatViewStore(() => false);
    const history = Array.from({ length: 10 }, (_, index) => assistant(String(index + 1)));
    const loadPage = mock(async (limit, offset) => {
      return historyPage(history, limit, offset);
    });
    const loader = { loadAll: snapshotLoader(async () => history), loadPage };

    await store.getOrCreatePage('chat-1', loader, 2);
    const wider = await store.getOrCreatePage('chat-1', loader, 6);

    expect(wider.messages.map((entry) => entry.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(loadPage.mock.calls.map((call) => call.slice(0, 2))).toEqual([[2, 0], [4, 2]]);
  });

  it('fills the missing prefix when beforeSeq overlaps the retained suffix', async () => {
    const store = new ChatViewStore(() => false);
    const history = Array.from({ length: 10 }, (_, index) => assistant(String(index + 1)));
    const loadPage = mock(async (limit, offset) => {
      return historyPage(history, limit, offset);
    });
    const loader = { loadAll: snapshotLoader(async () => history), loadPage };

    await store.getOrCreatePage('chat-1', loader, 2);
    const overlapping = await store.getOrCreatePage('chat-1', loader, 5, 10);

    expect(overlapping.messages.map((entry) => entry.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(loadPage.mock.calls.map((call) => call.slice(0, 2))).toEqual([[2, 0], [4, 2]]);
  });

  it('does not prune a view while an older page load is in flight', async () => {
    let now = 0;
    let releaseOlderPage;
    let markOlderPageStarted;
    const olderPageStarted = new Promise((resolve) => { markOlderPageStarted = resolve; });
    const olderPageGate = new Promise((resolve) => { releaseOlderPage = resolve; });
    const history = Array.from({ length: 4 }, (_, index) => assistant(String(index + 1)));
    const loader = {
      loadAll: snapshotLoader(async () => history),
      loadPage: async (limit, offset) => {
        if (offset > 0) {
          markOlderPageStarted();
          await olderPageGate;
        }
        return historyPage(history, limit, offset);
      },
    };
    const store = new ChatViewStore(() => false, {
      staleNonActiveMs: 10,
      recentViewRetentionCount: 0,
      now: () => now,
    });
    const recent = await store.getOrCreatePage('chat-1', loader, 1);

    now = 11;
    const pending = store.getOrCreatePage('chat-1', loader, 1, recent.pageOldestSeq);
    await olderPageStarted;
    now = 100;
    store.prune();
    releaseOlderPage();
    await pending;

    expect(store.readPage('chat-1', 4)?.generationId).toBe(recent.generationId);
  });

  it('pins a stale view while queue execution activity is reported', async () => {
    let now = 0;
    let queueDraining = true;
    const store = new ChatViewStore(
      (chatId) => chatId === 'chat-1' && queueDraining,
      { staleNonActiveMs: 10, recentViewRetentionCount: 0, now: () => now },
    );
    const created = await projectionAppender(store, 'chat-1')([assistant('queued user turn')]);

    now = 11;
    store.prune();
    expect(store.getCursor('chat-1')?.generationId).toBe(created.generationId);

    queueDraining = false;
    now = 22;
    store.prune();
    expect(store.getCursor('chat-1')).toBeNull();
  });

  it('bounds one active view and requires snapshots before its retained suffix', async () => {
    const store = new ChatViewStore(() => true, { messageLimit: 3 });
    const appended = await projectionAppender(store, 'chat-1', {
      historyRef: { current: Array.from({ length: 5 }, (_, index) => assistant(String(index + 1))) },
    })([assistant('live')]);

    const retained = store.readPage('chat-1', 10);
    expect(retained.messages.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    expect(contents(retained)).toEqual(['4', '5', 'live']);
    expect(store.getLoadedMessages('chat-1')).toBeNull();
    expect(store.getRetainedHistoryMessages('chat-1').map((message) => message.content)).toEqual([
      '4',
      '5',
      'live',
    ]);
    expect(store.readReplay('chat-1', appended.generationId, 2)?.mode).toBe('snapshot-required');
    expect(store.readReplay('chat-1', appended.generationId, 3)).toMatchObject({
      mode: 'delta',
      messages: retained.messages,
    });
  });

  it('trims active views to the global message budget without changing generations', async () => {
    const store = new ChatViewStore(() => true, { messageLimit: 3 });
    const first = await projectionAppender(store, 'chat-1')([assistant('1'), assistant('2')]);
    const second = await projectionAppender(store, 'chat-2')([assistant('3'), assistant('4')]);

    const firstRetained = store.readPage('chat-1', 10);
    const secondRetained = store.readPage('chat-2', 10);
    expect(firstRetained.generationId).toBe(first.generationId);
    expect(secondRetained.generationId).toBe(second.generationId);
    expect(firstRetained.messages.length + secondRetained.messages.length).toBe(3);
    expect(store.readReplay('chat-1', first.generationId, 0)?.mode).toBe('snapshot-required');
  });

  it('trims recently retained views instead of evicting their generations', async () => {
    const store = new ChatViewStore(() => false, {
      messageLimit: 3,
      recentViewRetentionCount: 2,
    });
    const first = await projectionAppender(store, 'chat-1')([assistant('1'), assistant('2')]);
    const second = await projectionAppender(store, 'chat-2')([assistant('3'), assistant('4')]);

    const firstRetained = store.readPage('chat-1', 10);
    const secondRetained = store.readPage('chat-2', 10);
    expect(firstRetained.generationId).toBe(first.generationId);
    expect(secondRetained.generationId).toBe(second.generationId);
    expect(firstRetained.messages.length + secondRetained.messages.length).toBe(3);
  });

  it('returns a wider in-flight page without growing the retained suffix past its cap', async () => {
    const history = Array.from({ length: 6 }, (_, index) => assistant(String(index + 1)));
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const loader = {
      loadAll: snapshotLoader(async () => history),
      loadPage: async (limit, offset) => {
        return historyPage(history, limit, offset);
      },
    };

    await store.getOrCreatePage('chat-1', loader, 2);
    const wider = await store.getOrCreatePage('chat-1', loader, 5);

    expect(wider.messages.map((entry) => entry.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(store.readPage('chat-1', 10)?.messages.map((entry) => entry.seq)).toEqual([5, 6]);
  });

  it('serves the requested page from a transient full load when transcript totals change', async () => {
    const initialHistory = Array.from({ length: 6 }, (_, index) => assistant(String(index + 1)));
    const updatedHistory = Array.from({ length: 7 }, (_, index) => assistant(String(index + 1)));
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const loader = {
      loadAll: mock(snapshotLoader(async () => updatedHistory)),
      loadPage: mock(async (limit, offset) => {
        const source = offset === 0 ? initialHistory : updatedHistory;
        return historyPage(source, limit, offset);
      }),
    };

    const recent = await store.getOrCreatePage('chat-1', loader, 2);
    const older = await store.getOrCreatePage('chat-1', loader, 2, 5);

    expect(older.generationId).not.toBe(recent.generationId);
    expect(older.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contents(older)).toEqual(['3', '4']);
    expect(store.readPage('chat-1', 10)?.messages.map((entry) => entry.seq)).toEqual([6, 7]);
    expect(loader.loadAll).toHaveBeenCalledTimes(1);
  });

  it('changes generation when an unretained native row changes at the same total', async () => {
    const historyRef = {
      current: Array.from({ length: 6 }, (_, index) => assistant(String(index + 1))),
    };
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const loader = pagedLoader(historyRef);
    const recent = await store.getOrCreatePage('chat-1', loader, 2);

    historyRef.current = [assistant('replacement'), ...historyRef.current.slice(1)];
    const older = await store.getOrCreatePage('chat-1', loader, 2, recent.pageOldestSeq);

    expect(older.generationId).not.toBe(recent.generationId);
    expect(contents(older)).toEqual(['3', '4']);
    expect(store.readPage('chat-1', 10)?.generationId).toBe(older.generationId);
  });

  it('changes generation when unretained native timestamps reorder rows', async () => {
    const first = new AssistantMessage('2026-06-01T00:00:01.000Z', 'first');
    const second = new AssistantMessage('2026-06-01T00:00:02.000Z', 'second');
    const tail = Array.from({ length: 4 }, (_, index) => (
      new AssistantMessage(`2026-06-01T00:00:0${index + 3}.000Z`, `tail-${index + 1}`)
    ));
    const historyRef = { current: [first, second, ...tail] };
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const loader = pagedLoader(historyRef);
    const recent = await store.getOrCreatePage('chat-1', loader, 2);

    historyRef.current = [second, first, ...tail];
    const older = await store.getOrCreatePage('chat-1', loader, 2, recent.pageOldestSeq);

    expect(older.generationId).not.toBe(recent.generationId);
  });

  it('changes generation when unretained compaction metadata changes', async () => {
    const historyRef = {
      current: [
        new CompactionMessage(TS, 'manual', 'summary', 100, 20),
        ...Array.from({ length: 5 }, (_, index) => assistant(String(index + 2))),
      ],
    };
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const loader = pagedLoader(historyRef);
    const recent = await store.getOrCreatePage('chat-1', loader, 2);

    historyRef.current = [
      new CompactionMessage(TS, 'auto', 'summary', 120, 24),
      ...historyRef.current.slice(1),
    ];
    const older = await store.getOrCreatePage('chat-1', loader, 2, recent.pageOldestSeq);

    expect(older.generationId).not.toBe(recent.generationId);
  });

  it('pages older full-only history under the same capped generation', async () => {
    const history = Array.from({ length: 6 }, (_, index) => assistant(String(index + 1)));
    const store = new ChatViewStore(() => false, { messageLimit: 3 });
    const loader = fullLoader(mock(async () => history));

    const recent = await store.getOrCreatePage('chat-1', loader, 2);
    const older = await store.getOrCreatePage('chat-1', loader, 2, recent.pageOldestSeq);

    expect(older.generationId).toBe(recent.generationId);
    expect(older.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contents(older)).toEqual(['3', '4']);
    expect(store.readPage('chat-1', 10)?.messages.map((entry) => entry.seq)).toEqual([4, 5, 6]);
  });

  it('requires a snapshot when a replay cursor predates the retained tail', async () => {
    const store = new ChatViewStore(() => false);
    const history = [user('one'), assistant('two'), assistant('three')];
    const page = await store.getOrCreatePage('chat-1', {
      loadAll: snapshotLoader(async () => history),
      loadPage: async (limit, offset) => historyPage(history, limit, offset),
    }, 1);

    expect(store.readReplay('chat-1', page.generationId, 0)).toMatchObject({
      mode: 'snapshot-required',
      lastSeq: 3,
    });
  });

  it('prunes stale views below the entry cap and enforces the message budget', async () => {
    let now = 0;
    const store = new ChatViewStore(() => false, {
      cacheLimit: 100,
      messageLimit: 2,
      staleNonActiveMs: 10,
      recentViewRetentionCount: 0,
      now: () => now,
    });
    const loads = new Map();
    const loaderFor = (chatId) => fullLoader(async () => {
      loads.set(chatId, (loads.get(chatId) ?? 0) + 1);
      return [assistant(chatId)];
    });

    await store.getOrCreatePage('chat-1', loaderFor('chat-1'), 1);
    now = 11;
    await store.getOrCreatePage('chat-2', loaderFor('chat-2'), 1);
    await store.getOrCreatePage('chat-1', loaderFor('chat-1'), 1);
    expect(loads.get('chat-1')).toBe(2);

    await store.getOrCreatePage('chat-3', loaderFor('chat-3'), 1);
    await store.getOrCreatePage('chat-2', loaderFor('chat-2'), 1);
    expect(loads.get('chat-2')).toBe(2);
  });

  it('retains the ten most recently accessed views after they become stale', async () => {
    let now = 0;
    const store = new ChatViewStore(() => false, {
      staleNonActiveMs: 10,
      now: () => now,
    });

    for (let index = 1; index <= 11; index += 1) {
      await store.getOrCreatePage(
        `chat-${index}`,
        fullLoader(async () => [assistant(String(index))]),
        1,
      );
    }
    const firstGenerationId = store.getCursor('chat-1').generationId;

    now = 11;
    store.prune();

    expect(store.getCursor('chat-2')).toBeNull();
    expect(store.getCursor('chat-1')?.generationId).toBe(firstGenerationId);
    for (let index = 3; index <= 11; index += 1) {
      expect(store.getCursor(`chat-${index}`)).not.toBeNull();
    }
  });

  it('logs stale prune evictions with the generation and reason', async () => {
    const originalInfo = console.info;
    const info = mock(() => undefined);
    console.info = info;
    try {
      let now = 0;
      const store = new ChatViewStore(() => false, {
        staleNonActiveMs: 10,
        recentViewRetentionCount: 0,
        now: () => now,
      });
      const page = await store.getOrCreatePage(
        'chat-1',
        fullLoader(async () => [assistant('one')]),
        1,
      );

      now = 11;
      store.prune();

      expect(info).toHaveBeenCalledWith(
        '[chat-view]',
        `view evicted chat=chat-1 generationId=${page.generationId} reason=stale ageMs=11 messages=1`,
      );
    } finally {
      console.info = originalInfo;
    }
  });
});

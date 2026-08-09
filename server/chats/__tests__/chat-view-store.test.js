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

  it('appends gap-free seq values after an atomic cold native load', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => [user('history')]);

    const appended = await store.appendAfterEnsuringGeneration('chat-1', transcriptLoader(loadNative), [
      assistant('live one'),
      assistant('live two'),
    ]);
    const page = store.readPage('chat-1', 20);

    expect(appended.messages.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(contents(page)).toEqual(['history', 'live one', 'live two']);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('does not append an optimistic retry over the same durable user identity', async () => {
    const store = new ChatViewStore(() => false);
    const identity = { clientRequestId: 'request-1', turnId: 'turn-1' };
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => [user('retry me', identity)]),
      [user('retry me', { ...identity, deliveryStatus: 'accepted' })],
    );

    expect(appended.messages).toEqual([]);
    expect(contents(store.readPage('chat-1', 20))).toEqual(['retry me']);
  });

  it('rejects conflicting content for one user delivery identity', async () => {
    const store = new ChatViewStore(() => false);
    const identity = { clientRequestId: 'request-1', turnId: 'turn-1' };

    await expect(store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => [user('original', identity)]),
      [user('conflict', identity)],
    )).rejects.toThrow('Conflicting user message identity: request-1');
  });

  it('lets an authoritative full native snapshot replace a conflicting retained row', async () => {
    const store = new ChatViewStore(() => false);
    const identity = { clientRequestId: 'request-1', turnId: 'turn-1' };
    await store.appendToCurrentOrProvisional('chat-1', [
      assistant('provisional'),
      user('optimistic content', identity),
    ]);

    const messages = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => [user('provider content', identity)]),
    );

    expect(messages.map((message) => message.content)).toEqual(['provider content']);
    expect(contents(store.readPage('chat-1', 20))).toEqual(['provider content']);
  });

  it('reconciles shifted native echoes by exact provider identities', async () => {
    const store = new ChatViewStore(() => false);
    const initialHistory = [
      user('old user one'),
      assistant('old assistant one'),
      user('old user two'),
      assistant('old assistant two'),
    ];
    const liveUser = user('live user content', {
      clientRequestId: 'client-request-1',
      turnId: 'turn-1',
      upstreamRequestId: 'provider-request-1',
      deliveryStatus: 'accepted',
    });
    const liveAssistant = attachNativeMessageSource(assistant('live assistant content'), {
      entryId: 'turn:provider-turn-1:item:provider-item-1',
      withinSourceOrdinal: 0,
    });
    await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => initialHistory),
      [liveUser, liveAssistant],
    );

    const nativeUser = user('provider user content', {
      upstreamRequestId: 'provider-request-1',
    });
    const nativeAssistant = attachNativeMessageSource(assistant('provider assistant content'), {
      entryId: 'turn:provider-turn-1:item:provider-item-1',
      withinSourceOrdinal: 0,
    });
    await store.reconcileNativeSnapshot('chat-1', nativeReconciliation([
      ...initialHistory.slice(0, 2),
      nativeUser,
      nativeAssistant,
    ]));

    const messages = store.readPage('chat-1', 20).messages.map((entry) => entry.message);
    expect(messages.map((message) => message.content)).toEqual([
      'old user one',
      'old assistant one',
      'provider user content',
      'provider assistant content',
    ]);
    expect(messages[2].metadata).toEqual({
      clientRequestId: 'client-request-1',
      turnId: 'turn-1',
      upstreamRequestId: 'provider-request-1',
      deliveryStatus: 'accepted',
    });
  });

  it('rebuilds a generation when archived tail reconciliation shifts native messages', async () => {
    const store = new ChatViewStore(() => false);
    const archived = user('archived');
    const liveUser = user('continued', { clientRequestId: 'request-1' });
    const liveAssistant = assistant('answer');
    const initial = await store.appendAfterEnsuringGeneration(
      'chat-1',
      {
        loadAll: async () => transcriptSnapshot([archived], {
          archivedLogicalCount: 1,
          carryOverRevision: 'carry-old',
          nativeMessages: [],
        }),
      },
      [liveUser, liveAssistant],
    );
    const boundary = new AgentSwitchMessage(TS, 'agent-a', 'agent-b');

    await store.reconcileFullSnapshot('chat-1', transcriptSnapshot([
      archived,
      boundary,
      liveUser,
      liveAssistant,
    ], {
      archivedLogicalCount: 2,
      carryOverRevision: 'carry-new',
      nativeMessages: [liveUser, liveAssistant],
    }));

    const page = store.readPage('chat-1', 20);
    expect(page.generationId).not.toBe(initial.generationId);
    expect(page.messages.map(({ seq, message }) => [seq, message.type])).toEqual([
      [1, 'user-message'],
      [2, 'agent-switch'],
      [3, 'user-message'],
      [4, 'assistant-message'],
    ]);
  });

  it('keeps identical native and live text without a shared identity', async () => {
    const store = new ChatViewStore(() => false);
    const initialHistory = [
      user('old user one'),
      assistant('old assistant one'),
      user('old user two'),
      assistant('old assistant two'),
    ];
    const liveUser = user('same user text', {
      upstreamRequestId: 'live-provider-request',
    });
    const liveAssistant = attachNativeMessageSource(assistant('same assistant text'), {
      entryId: 'turn:shared-turn:item:shared-item',
      withinSourceOrdinal: 0,
    });
    await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => initialHistory),
      [liveUser, liveAssistant],
    );

    const nativeUser = user('same user text', {
      upstreamRequestId: 'native-provider-request',
    });
    const nativeAssistant = attachNativeMessageSource(assistant('same assistant text'), {
      entryId: 'turn:shared-turn:item:shared-item',
      withinSourceOrdinal: 1,
    });
    await store.reconcileNativeSnapshot('chat-1', nativeReconciliation([
      ...initialHistory.slice(0, 2),
      nativeUser,
      nativeAssistant,
    ]));

    expect(contents(store.readPage('chat-1', 20))).toEqual([
      'old user one',
      'old assistant one',
      'same user text',
      'same assistant text',
      'same user text',
      'same assistant text',
    ]);
  });

  it('rejects a restored native snapshot after execution becomes active', async () => {
    let active = false;
    const store = new ChatViewStore(() => active);
    await store.appendToCurrentOrProvisional('chat-1', [assistant('live output')]);
    active = true;

    await expect(store.reconcileNativeSnapshot(
      'chat-1',
      nativeReconciliation([assistant('stale native output')]),
    ))
      .rejects.toMatchObject({ code: 'CHAT_RUNNING' });

    expect(contents(store.readPage('chat-1', 20))).toEqual(['live output']);
  });

  it('does not replace an existing generation during a later get-or-create read', async () => {
    const store = new ChatViewStore(() => false);
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [assistant('live')],
    );

    const page = await store.getOrCreatePage(
      'chat-1',
      fullLoader(async () => [assistant('native after live')]),
      20,
    );

    expect(page.generationId).toBe(appended.generationId);
    expect(contents(page)).toEqual(['live']);
  });

  it('serializes concurrent cold appends under one generation', async () => {
    const store = new ChatViewStore(() => false);
    const loadNative = mock(async () => [user('history')]);

    const [first, second] = await Promise.all([
      store.appendAfterEnsuringGeneration('chat-1', transcriptLoader(loadNative), [assistant('a')]),
      store.appendAfterEnsuringGeneration('chat-1', transcriptLoader(loadNative), [assistant('b')]),
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
      transcriptLoader(async () => []),
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
      transcriptLoader(async () => []),
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

  it('retains operational notices across native reconciliation and reload', async () => {
    const store = new ChatViewStore(() => false);
    const prompt = user('continue here');
    const nativeMessages = [prompt, assistant('working'), assistant('done')];
    const warning = new ErrorMessage(TS, 'Carryover compaction failed; using fallback.');
    await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [prompt],
    );
    await store.appendOperationalNotice('chat-1', warning);
    await store.appendToCurrentOrProvisional('chat-1', [
      new ErrorMessage(TS, 'Superseded provisional error.'),
    ]);

    await store.reconcileNativeSnapshot('chat-1', nativeReconciliation(nativeMessages));

    expect(contents(store.readPage('chat-1', 20))).toEqual([
      'continue here',
      'working',
      'done',
      'Carryover compaction failed; using fallback.',
    ]);

    store.invalidate('chat-1');
    const reloaded = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => nativeMessages),
    );
    expect(reloaded.map((message) => message.content)).toEqual([
      'continue here',
      'working',
      'done',
      'Carryover compaction failed; using fallback.',
    ]);

    store.deleteChatView('chat-1');
    const afterDeletion = await store.getOrCreatePage(
      'chat-1',
      transcriptLoader(async () => nativeMessages),
      20,
    );
    expect(contents(afterDeletion)).toEqual(['continue here', 'working', 'done']);
  });

  it('eviction causes the next access to mint a new generation', async () => {
    const store = new ChatViewStore(() => false);
    const first = await store.getOrCreatePage('chat-1', fullLoader(async () => [assistant('old')]), 20);

    store.evict('chat-1');
    const second = await store.getOrCreatePage('chat-1', fullLoader(async () => [assistant('new')]), 20);

    expect(second.generationId).not.toBe(first.generationId);
    expect(contents(second)).toEqual(['new']);
  });

  it('invalidates stale stream output whenever native history replaces a generation', async () => {
    const store = new ChatViewStore(() => false);
    const fence = store.captureFence('chat-1');

    await store.replaceFromNative('chat-1', snapshotLoader(async () => [assistant('native')]));
    const stale = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [assistant('late')],
      { fence },
    );
    const page = store.readPage('chat-1', 20);

    expect(stale.skipped).toBe(true);
    expect(stale.messages).toEqual([]);
    expect(contents(page)).toEqual(['native']);
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

  it('appends to a revalidated page generation without loading full history', async () => {
    const history = Array.from({ length: 10 }, (_, index) => assistant(String(index + 1)));
    const loadAll = mock(snapshotLoader(async () => history));
    const loadPage = mock(async (limit, offset) => historyPage(history, limit, offset));
    const loader = { loadAll, loadPage };
    const store = new ChatViewStore(() => false);
    const recent = await store.getOrCreatePage('chat-1', loader, 2);

    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      loader,
      [assistant('live')],
    );

    expect(appended.generationId).toBe(recent.generationId);
    expect(appended.messages.map((entry) => entry.seq)).toEqual([11]);
    expect(loadAll).not.toHaveBeenCalled();
    expect(loadPage).toHaveBeenLastCalledWith(2048, 0);
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
    const created = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [assistant('queued user turn')],
    );

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
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => Array.from({ length: 5 }, (_, index) => assistant(String(index + 1)))),
      [assistant('live')],
    );

    const retained = store.readPage('chat-1', 10);
    expect(retained.messages.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    expect(contents(retained)).toEqual(['4', '5', 'live']);
    expect(store.getLoadedMessages('chat-1')).toBeNull();
    expect(store.getRetainedHistoryMessages('chat-1').map((message) => message.content)).toEqual([
      '4',
      '5',
    ]);
    expect(store.readReplay('chat-1', appended.generationId, 2)?.mode).toBe('snapshot-required');
    expect(store.readReplay('chat-1', appended.generationId, 3)).toMatchObject({
      mode: 'delta',
      messages: retained.messages,
    });
  });

  it('trims active views to the global message budget without changing generations', async () => {
    const store = new ChatViewStore(() => true, { messageLimit: 3 });
    const first = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [assistant('1'), assistant('2')],
    );
    const second = await store.appendAfterEnsuringGeneration(
      'chat-2',
      transcriptLoader(async () => []),
      [assistant('3'), assistant('4')],
    );

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
    const first = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => []),
      [assistant('1'), assistant('2')],
    );
    const second = await store.appendAfterEnsuringGeneration(
      'chat-2',
      transcriptLoader(async () => []),
      [assistant('3'), assistant('4')],
    );

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

  it('logs explicit reasons for preserved and replaced native generations', async () => {
    const originalInfo = console.info;
    const info = mock(() => undefined);
    console.info = info;
    try {
      const initialHistory = [assistant('1'), assistant('2'), assistant('3')];
      const historyRef = { current: initialHistory };
      const store = new ChatViewStore(() => false);
      const initial = await store.getOrCreatePage('chat-1', pagedLoader(historyRef), 1);

      await store.getOrCreateMessages('chat-1', snapshotLoader(async () => initialHistory));
      const fullGeneration = store.getCursor('chat-1').generationId;
      expect(fullGeneration).not.toBe(initial.generationId);
      await store.reconcileNativeSnapshot('chat-1', nativeReconciliation(initialHistory));
      const preserved = store.getCursor('chat-1').generationId;
      await store.reconcileNativeSnapshot('chat-1', nativeReconciliation([
        assistant('replacement'),
        ...initialHistory.slice(1),
      ]));
      const replaced = store.getCursor('chat-1').generationId;

      expect(preserved).toBe(fullGeneration);
      expect(replaced).not.toBe(preserved);
      const messages = info.mock.calls.map((call) => call[1]);
      expect(messages.some((message) => (
        message.includes('generation preserved')
        && message.includes(`generationId=${preserved}`)
        && message.includes('reason=native-history-reconciled')
      ))).toBe(true);
      expect(messages.some((message) => (
        message.includes('generation replaced')
        && message.includes(`generationId=${replaced}`)
        && message.includes('reason=native-history-mismatch')
        && message.includes(`previousGenerationId=${preserved}`)
      ))).toBe(true);
    } finally {
      console.info = originalInfo;
    }
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

  it('preserves generation when a trimmed live append becomes native history', async () => {
    const history = Array.from({ length: 6 }, (_, index) => assistant(String(index + 1)));
    const store = new ChatViewStore(() => false, { messageLimit: 3 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      [assistant('7')],
    );

    const reconciled = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => [...history, assistant('7')]),
    );

    expect(store.getCursor('chat-1')?.generationId).toBe(appended.generationId);
    expect(reconciled.map((message) => message.content)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(store.readPage('chat-1', 10)?.messages.map((entry) => entry.seq)).toEqual([5, 6, 7]);
  });

  it('keeps the newest unpersisted live row after partial native persistence', async () => {
    const history = Array.from({ length: 6 }, (_, index) => assistant(String(index + 1)));
    const store = new ChatViewStore(() => false, { messageLimit: 3 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      [assistant('7'), assistant('8')],
    );

    const reconciled = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => [...history, assistant('7')]),
    );

    expect(store.getCursor('chat-1')?.generationId).toBe(appended.generationId);
    expect(reconciled.map((message) => message.content)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8',
    ]);
    expect(store.readPage('chat-1', 10)?.messages.map((entry) => entry.seq)).toEqual([6, 7, 8]);
    expect(contents(store.readPage('chat-1', 10))).toEqual(['6', '7', '8']);
  });

  it('preserves retained live rows when native growth closes the trimmed prefix', async () => {
    const history = [assistant('h1'), assistant('h2')];
    const live = [assistant('l3'), assistant('l4'), assistant('l5'), assistant('l6')];
    const store = new ChatViewStore(() => false, { messageLimit: 3 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      live,
    );

    const reconciled = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => [...history, live[0]]),
    );

    expect(store.getCursor('chat-1')?.generationId).toBe(appended.generationId);
    expect(reconciled.map((message) => message.content)).toEqual([
      'h1', 'h2', 'l3', 'l4', 'l5', 'l6',
    ]);
    const retained = store.readPage('chat-1', 10);
    expect(retained.messages.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    expect(contents(retained)).toEqual(['l4', 'l5', 'l6']);
  });

  it('rotates generation when persisted native growth mismatches evicted live rows', async () => {
    const history = [assistant('h1'), assistant('h2')];
    const live = [assistant('l3'), assistant('l4'), assistant('l5'), assistant('l6')];
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      live,
    );

    const reconciled = await store.getOrCreateMessages('chat-1', snapshotLoader(async () => [
      ...history,
      assistant('wrong-l3'),
      live[1],
    ]));

    expect(store.getCursor('chat-1')?.generationId).not.toBe(appended.generationId);
    expect(reconciled.map((message) => message.content)).toEqual([
      'h1', 'h2', 'wrong-l3', 'l4', 'l5', 'l6',
    ]);
    expect(contents(store.readPage('chat-1', 10))).toEqual(['l5', 'l6']);
  });

  it('resequences retained live rows when an evicted gap is not yet persisted', async () => {
    const history = [assistant('h1'), assistant('h2')];
    const live = [assistant('l3'), assistant('l4'), assistant('l5'), assistant('l6')];
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      live,
    );

    const reconciled = await store.getOrCreateMessages(
      'chat-1',
      snapshotLoader(async () => history),
    );

    expect(store.getCursor('chat-1')?.generationId).not.toBe(appended.generationId);
    expect(reconciled.map((message) => message.content)).toEqual(['h1', 'h2', 'l5', 'l6']);
    const retained = store.readPage('chat-1', 10);
    expect(retained.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contents(retained)).toEqual(['l5', 'l6']);
  });

  it('reconciles an unpersisted evicted live gap before paging across it', async () => {
    const historyRef = { current: [assistant('h1'), assistant('h2')] };
    const live = [assistant('l3'), assistant('l4'), assistant('l5'), assistant('l6')];
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => historyRef.current),
      live,
    );

    const acrossGap = await store.getOrCreatePage(
      'chat-1',
      pagedLoader(historyRef),
      2,
      5,
    );

    expect(acrossGap.generationId).not.toBe(appended.generationId);
    expect(acrossGap.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contents(acrossGap)).toEqual(['l5', 'l6']);
    expect(acrossGap.hasMore).toBe(true);

    const olderNative = await store.getOrCreatePage(
      'chat-1',
      pagedLoader(historyRef),
      2,
      3,
    );
    expect(olderNative.generationId).toBe(acrossGap.generationId);
    expect(contents(olderNative)).toEqual(['h1', 'h2']);
    expect(olderNative.hasMore).toBe(false);
  });

  it('preserves generation when native history closes the evicted live gap', async () => {
    const historyRef = { current: [assistant('h1'), assistant('h2')] };
    const live = [assistant('l3'), assistant('l4'), assistant('l5'), assistant('l6')];
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => historyRef.current),
      live,
    );
    historyRef.current = [...historyRef.current, live[0], live[1]];

    const acrossGap = await store.getOrCreatePage(
      'chat-1',
      pagedLoader(historyRef),
      2,
      5,
    );

    expect(acrossGap.generationId).toBe(appended.generationId);
    expect(acrossGap.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(contents(acrossGap)).toEqual(['l3', 'l4']);
    expect(acrossGap.hasMore).toBe(true);
  });

  it('changes generation when persisted live timestamps differ', async () => {
    const history = [assistant('h1'), assistant('h2')];
    const live = new AssistantMessage('2026-06-01T00:00:03.000Z', 'l3');
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      [live],
    );

    await store.getOrCreateMessages('chat-1', snapshotLoader(async () => [
      ...history,
      new AssistantMessage('2026-06-01T00:00:04.000Z', 'l3'),
    ]));

    expect(store.getCursor('chat-1')?.generationId).not.toBe(appended.generationId);
  });

  it('changes generation when persisted live metadata differs', async () => {
    const history = [assistant('h1'), assistant('h2')];
    const live = new UserMessage(TS, 'l3', undefined, { turnId: 'live-turn' });
    const store = new ChatViewStore(() => false, { messageLimit: 2 });
    const appended = await store.appendAfterEnsuringGeneration(
      'chat-1',
      transcriptLoader(async () => history),
      [live],
    );

    await store.getOrCreateMessages('chat-1', snapshotLoader(async () => [
      ...history,
      new UserMessage(TS, 'l3', undefined, { turnId: 'native-turn' }),
    ]));

    expect(store.getCursor('chat-1')?.generationId).not.toBe(appended.generationId);
  });

  it('upgrades a partial view only when a full-history consumer requires it', async () => {
    const store = new ChatViewStore(() => false);
    const history = [user('one'), assistant('two'), assistant('three')];
    const loadAll = mock(async () => history);
    const loadPage = mock(async (limit, offset) => historyPage(history, limit, offset));

    const page = await store.getOrCreatePage(
      'chat-1',
      { loadAll: snapshotLoader(loadAll), loadPage },
      1,
    );
    expect(contents(page)).toEqual(['three']);
    expect(store.getLoadedMessages('chat-1')).toBeNull();

    const loaded = await store.getOrCreateMessages('chat-1', snapshotLoader(loadAll));
    expect(loaded.map((message) => message.content)).toEqual(['one', 'two', 'three']);
    expect(store.getLoadedMessages('chat-1')).toHaveLength(3);
    expect(loadAll).toHaveBeenCalledTimes(1);
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

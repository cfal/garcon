import { describe, expect, it, mock } from 'bun:test';
import { IdleNativeReconciler } from '../idle-native-reconciler.ts';
import { ChatRunningError } from '../errors.ts';
import {
  nativeReconciliation,
  transcriptSnapshot,
} from './chat-transcript-test-helpers.js';
import { AssistantMessage } from '../../../common/chat-types.js';

const CHAT_ID = 'chat-1';
const TS = '2026-06-01T00:00:00.000Z';

function harness(overrides = {}) {
  const state = {
    cursor: { generationId: 'gen-1', lastSeq: 4 },
    ...overrides.state,
  };
  const views = {
    getCursor: mock(() => state.cursor),
    reconcileNativeSnapshot: mock(async () => {
      state.cursor = { generationId: 'gen-2', lastSeq: 2 };
    }),
    reconcileFullSnapshot: mock(async () => {
      state.cursor = { generationId: 'gen-3', lastSeq: 3 };
    }),
    ...overrides.views,
  };
  const source = {
    loadNativeSnapshot: mock(async () => nativeReconciliation([])),
    loadFullSnapshot: mock(async () => transcriptSnapshot([])),
    ...overrides.source,
  };
  const resets = [];
  const reconciler = new IdleNativeReconciler({
    views,
    source,
    ownsExecution: overrides.ownsExecution ?? (() => false),
    onGenerationReset: overrides.onGenerationReset ?? ((
      chatId,
      previousGenerationId,
      generationId,
      lastSeq,
    ) => {
      resets.push({ chatId, previousGenerationId, generationId, lastSeq });
    }),
    debounceMs: 0,
    settleMs: 0,
  });
  return { reconciler, views, source, resets, state };
}

describe('IdleNativeReconciler', () => {
  it('rebuilds a view whose seqs outran native history and announces the reset', async () => {
    const { reconciler, views, resets } = harness();

    await reconciler.ensureReconciled(CHAT_ID);

    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
    expect(resets).toEqual([{
      chatId: CHAT_ID,
      previousGenerationId: 'gen-1',
      generationId: 'gen-2',
      lastSeq: 2,
    }]);
  });

  it('still validates native content when the view and native totals match', async () => {
    const { reconciler, views, resets } = harness({
      state: { cursor: { generationId: 'gen-1', lastSeq: 2 } },
      views: {
        reconcileNativeSnapshot: mock(async () => undefined),
      },
    });

    await reconciler.ensureReconciled(CHAT_ID);

    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
    expect(resets).toEqual([]);
  });

  it('rebuilds the full transcript after its archived composition changes', async () => {
    const { reconciler, views, source, resets } = harness();
    reconciler.noteHistoryChanged(CHAT_ID);

    await reconciler.ensureHistoryChangeReconciled(CHAT_ID);

    expect(source.loadFullSnapshot).toHaveBeenCalledTimes(2);
    expect(source.loadNativeSnapshot).not.toHaveBeenCalled();
    expect(views.reconcileFullSnapshot).toHaveBeenCalledTimes(1);
    expect(views.reconcileNativeSnapshot).not.toHaveBeenCalled();
    expect(resets).toEqual([{
      chatId: CHAT_ID,
      previousGenerationId: 'gen-1',
      generationId: 'gen-3',
      lastSeq: 3,
    }]);
  });

  it('retains a changed-history request until two full snapshots agree', async () => {
    let read = 0;
    const { reconciler, views } = harness({
      source: {
        loadFullSnapshot: mock(async () => {
          read += 1;
          return transcriptSnapshot(
            read === 1 ? [] : [new AssistantMessage(TS, 'settled')],
          );
        }),
      },
    });
    reconciler.noteHistoryChanged(CHAT_ID);

    await reconciler.ensureHistoryChangeReconciled(CHAT_ID);
    expect(views.reconcileFullSnapshot).not.toHaveBeenCalled();

    await reconciler.ensureHistoryChangeReconciled(CHAT_ID);
    expect(views.reconcileFullSnapshot).toHaveBeenCalledTimes(1);
  });

  it('declines while a turn owns the chat', async () => {
    const { reconciler, views } = harness({ ownsExecution: () => true });

    await reconciler.ensureReconciled(CHAT_ID);

    expect(views.reconcileNativeSnapshot).not.toHaveBeenCalled();
  });

  it('stays quiet when a turn claims the view mid-reconcile', async () => {
    const { reconciler, views, resets } = harness({
      views: {
        reconcileNativeSnapshot: mock(async () => {
          throw new ChatRunningError(CHAT_ID);
        }),
      },
    });

    await expect(reconciler.ensureReconciled(CHAT_ID)).resolves.toBeUndefined();
    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
    expect(resets).toEqual([]);
  });

  it('coalesces concurrent callers onto one reconcile', async () => {
    const { reconciler, views } = harness();

    await Promise.all([
      reconciler.ensureReconciled(CHAT_ID),
      reconciler.ensureReconciled(CHAT_ID),
    ]);

    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('abandons pending and future work once stopped', async () => {
    const { reconciler, views } = harness();
    reconciler.noteIdle(CHAT_ID);

    reconciler.stop();
    reconciler.noteIdle(CHAT_ID);
    await reconciler.ensureReconciled(CHAT_ID);

    expect(views.reconcileNativeSnapshot).not.toHaveBeenCalled();
  });

  it('defers to a transcript that is still flushing and retries on the next signal', async () => {
    let read = 0;
    const { reconciler, views } = harness({
      source: {
        loadNativeSnapshot: mock(async () => {
          read += 1;
          return nativeReconciliation(
            read < 2 ? [] : [new AssistantMessage(TS, 'settled')],
          );
        }),
      },
    });

    await reconciler.ensureReconciled(CHAT_ID);
    expect(views.reconcileNativeSnapshot).not.toHaveBeenCalled();

    await reconciler.ensureReconciled(CHAT_ID);
    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('abandons an in-flight reconcile when stopped during the settle wait', async () => {
    const { reconciler, views } = harness();
    const inFlight = reconciler.ensureReconciled(CHAT_ID);
    reconciler.stop();

    await inFlight;

    expect(views.reconcileNativeSnapshot).not.toHaveBeenCalled();
  });

  it('contains a failing reset announcement instead of rejecting', async () => {
    const { reconciler, views } = harness({
      onGenerationReset: () => {
        throw new Error('publisher unavailable');
      },
    });

    await expect(reconciler.ensureReconciled(CHAT_ID)).resolves.toBeUndefined();
    expect(views.reconcileNativeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not announce a reset when the generation survives', async () => {
    const { reconciler, resets } = harness({
      views: {
        reconcileNativeSnapshot: mock(async () => undefined),
      },
    });

    await reconciler.ensureReconciled(CHAT_ID);

    expect(resets).toEqual([]);
  });
});

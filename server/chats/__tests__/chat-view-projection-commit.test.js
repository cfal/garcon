import { describe, expect, it, mock } from 'bun:test';
import { ChatViewStore } from '../chat-view-store.js';
import { ChatTransientFeedStore } from '../chat-transient-feed.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import {
  historyPage,
  transcriptSnapshot,
} from './chat-transcript-test-helpers.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content) {
  return new UserMessage(TS, content);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function projection(overrides = {}) {
  const total = overrides.total ?? 0;
  return {
    epoch: 'stream-epoch-1',
    contentEpoch: 'content-epoch-1',
    total,
    durableCount: overrides.durableCount ?? total,
    durableRevision: `durable-rev-${overrides.durableCount ?? total}`,
    stateRevision: `state-rev-${total}`,
    ...overrides,
  };
}

function loaderFor(messages, options = {}) {
  return {
    loadAll: mock(async () => transcriptSnapshot(messages, options)),
    loadPage: mock(async (limit, offset) => historyPage(messages, limit, offset, options)),
  };
}

async function loadedStore(messages, state, options = {}) {
  const store = new ChatViewStore(() => false);
  const loader = loaderFor(messages, { ...options, projectionState: state });
  const page = await store.getOrCreatePage('chat-1', loader, 100);
  return { store, page };
}

describe('ChatViewStore.applyProjectionCommit', () => {
  it('appends exact commit entries at carryover plus ordinal seqs', async () => {
    const previous = projection({ total: 2 });
    const { store, page } = await loadedStore([user('hello'), assistant('hi')], previous);
    const checkpoint = projection({ total: 4 });

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: checkpoint,
      appendedMessages: [assistant('first'), assistant('second')],
      carryOverMessageCount: 0,
    }, loaderFor([], {}));

    expect(applied.kind).toBe('applied');
    expect(applied.generationId).toBe(page.generationId);
    expect(applied.messages.map((entry) => entry.seq)).toEqual([3, 4]);
    expect(applied.lastSeq).toBe(4);
    const read = store.readPage('chat-1', 10);
    expect(read.messages.map((entry) => entry.message.content)).toEqual([
      'hello', 'hi', 'first', 'second',
    ]);
    expect(store.getNativeHistoryLastSeq('chat-1')).toBe(4);
  });

  it('offsets appended seqs by the carryover message count', async () => {
    const previous = projection({ total: 1 });
    const { store } = await loadedStore(
      [user('archived'), user('archived two'), assistant('current')],
      previous,
      { archivedLogicalCount: 2 },
    );
    const checkpoint = projection({ total: 2 });

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: checkpoint,
      appendedMessages: [assistant('appended')],
      carryOverMessageCount: 2,
    }, loaderFor([], {}));

    expect(applied.kind).toBe('applied');
    expect(applied.messages.map((entry) => entry.seq)).toEqual([4]);
  });

  it('advances projection state without rows for promotion-only commits', async () => {
    const previous = projection({ total: 2, durableCount: 1 });
    const { store, page } = await loadedStore([user('hello'), assistant('hi')], previous);
    const checkpoint = projection({ total: 2, durableCount: 2 });

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: checkpoint,
      appendedMessages: [],
      carryOverMessageCount: 0,
    }, loaderFor([], {}));

    expect(applied.kind).toBe('applied');
    expect(applied.messages).toEqual([]);
    expect(applied.lastSeq).toBe(2);

    const repeat = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: checkpoint,
      appendedMessages: [],
      carryOverMessageCount: 0,
    }, loaderFor([], {}));
    expect(repeat.kind).toBe('already-applied');
    expect(repeat.generationId).toBe(page.generationId);
  });

  it('treats a commit whose checkpoint already matches the view as applied', async () => {
    const checkpoint = projection({ total: 2 });
    const { store, page } = await loadedStore([user('hello'), assistant('hi')], checkpoint);

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: projection({ total: 1 }),
      checkpointProjection: checkpoint,
      appendedMessages: [assistant('hi')],
      carryOverMessageCount: 0,
    }, loaderFor([], {}));

    expect(applied).toEqual({
      kind: 'already-applied',
      generationId: page.generationId,
      lastSeq: 2,
    });
    expect(store.readPage('chat-1', 10).messages).toHaveLength(2);
  });

  it('relists under a new generation when the view matches neither commit state', async () => {
    const stale = projection({ total: 1, epoch: 'stream-epoch-0' });
    const { store, page } = await loadedStore([user('hello')], stale);
    const previous = projection({ total: 2 });
    const checkpoint = projection({ total: 3 });
    const current = [user('hello'), assistant('hi'), assistant('done')];

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: checkpoint,
      appendedMessages: [assistant('done')],
      carryOverMessageCount: 0,
    }, loaderFor(current, { projectionState: checkpoint }));

    expect(applied.kind).toBe('relisted');
    expect(applied.previousGenerationId).toBe(page.generationId);
    expect(applied.generationId).not.toBe(page.generationId);
    expect(applied.lastSeq).toBe(3);
    const read = store.readPage('chat-1', 10);
    expect(read.generationId).toBe(applied.generationId);
    expect(read.messages.map((entry) => entry.message.content)).toEqual([
      'hello', 'hi', 'done',
    ]);
  });

  it('relists when no view is loaded', async () => {
    const store = new ChatViewStore(() => false);
    const checkpoint = projection({ total: 1 });

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: projection({ total: 0 }),
      checkpointProjection: checkpoint,
      appendedMessages: [assistant('first')],
      carryOverMessageCount: 0,
    }, loaderFor([assistant('first')], { projectionState: checkpoint }));

    expect(applied.kind).toBe('relisted');
    expect(applied.previousGenerationId).toBeNull();
    expect(store.getCursor('chat-1')?.generationId).toBe(applied.generationId);
  });

  it('relists when the carryover count no longer matches the view layout', async () => {
    const previous = projection({ total: 2 });
    const { store } = await loadedStore([user('hello'), assistant('hi')], previous);

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: projection({ total: 3 }),
      appendedMessages: [assistant('late')],
      carryOverMessageCount: 5,
    }, loaderFor([user('hello'), assistant('hi'), assistant('late')], {
      projectionState: projection({ total: 3 }),
    }));

    expect(applied.kind).toBe('relisted');
  });

  it('relists without mutating the view when appended rows disagree with the checkpoint total', async () => {
    const previous = projection({ total: 2 });
    const { store } = await loadedStore([user('hello'), assistant('hi')], previous);

    const applied = await store.applyProjectionCommit('chat-1', {
      previousProjection: previous,
      checkpointProjection: projection({ total: 5 }),
      appendedMessages: [assistant('only-one')],
      carryOverMessageCount: 0,
    }, loaderFor([user('hello'), assistant('hi')], { projectionState: previous }));

    expect(applied.kind).toBe('relisted');
    expect(store.readPage('chat-1', 10).messages).toHaveLength(2);
  });

  it('invalidates the stream fence when relisting', async () => {
    const stale = projection({ total: 1, epoch: 'stream-epoch-0' });
    const { store } = await loadedStore([user('hello')], stale);
    const fence = store.captureFence('chat-1');

    await store.applyProjectionCommit('chat-1', {
      previousProjection: projection({ total: 1 }),
      checkpointProjection: projection({ total: 2 }),
      appendedMessages: [assistant('hi')],
      carryOverMessageCount: 0,
    }, loaderFor([user('hello'), assistant('hi')], {
      projectionState: projection({ total: 2 }),
    }));

    expect(store.captureFence('chat-1')).toBe(fence + 1);
  });
});

describe('ChatTransientFeedStore.rebaseGeneration', () => {
  const owner = {
    agentOwnershipEpoch: 'ownership-1',
    commandType: 'agent-run',
    clientRequestId: 'request-1',
    turnId: 'turn-1',
  };

  function feedWithRow() {
    const feeds = new ChatTransientFeedStore('server-1');
    const applied = {
      event: {
        kind: 'control',
        chatId: 'chat-1',
        agentOwnershipEpoch: 'ownership-1',
        operation: { ...owner, clientMessageId: null, turnOwner: owner },
        mutation: {
          kind: 'upsert',
          row: {
            id: 'permission-1',
            incarnation: 'incarnation-1',
            operation: { ...owner, clientMessageId: null, turnOwner: owner },
            anchorEntryId: null,
            displayOrder: 1,
            message: new AssistantMessage(TS, 'placeholder'),
          },
        },
      },
      current: {
        entries: [{ lifetime: 'durable' }],
        checkpoint: { projection: { durableCount: 1 } },
        controls: new Map(),
      },
    };
    const result = feeds.apply(applied, {
      generationId: 'generation-1',
      carryOverMessageCount: 2,
    });
    expect(result.kind).toBe('mutation');
    return feeds;
  }

  it('preserves control rows and anchors under the new generation', () => {
    const feeds = feedWithRow();

    const transition = feeds.rebaseGeneration({
      chatId: 'chat-1',
      agentOwnershipEpoch: 'ownership-1',
      previousGenerationId: 'generation-1',
      generationId: 'generation-2',
    });

    expect(transition.previousGenerationId).toBe('generation-1');
    expect(transition.generationId).toBe('generation-2');
    expect(transition.resetTransactionId).toBeTruthy();
    expect(transition.rows).toHaveLength(1);
    expect(transition.rows[0]).toMatchObject({
      id: 'permission-1',
      incarnation: 'incarnation-1',
      transcript: { generationId: 'generation-2', afterSeq: 3 },
    });

    const snapshot = feeds.currentSnapshot('chat-1');
    expect(snapshot.generationId).toBe('generation-2');
    expect(snapshot.transientRevision).toBe(transition.transientRevision);
  });

  it('rejects a stale predecessor generation', () => {
    const feeds = feedWithRow();

    expect(() => feeds.rebaseGeneration({
      chatId: 'chat-1',
      agentOwnershipEpoch: 'ownership-1',
      previousGenerationId: 'generation-0',
      generationId: 'generation-2',
    })).toThrow('Generation rebase predecessor is stale');
  });

  it('rejects identical generations', () => {
    const feeds = feedWithRow();

    expect(() => feeds.rebaseGeneration({
      chatId: 'chat-1',
      agentOwnershipEpoch: 'ownership-1',
      previousGenerationId: 'generation-1',
      generationId: 'generation-1',
    })).toThrow('Generation rebase requires distinct generations');
  });
});

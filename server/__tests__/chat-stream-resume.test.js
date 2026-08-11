import { describe, expect, it } from 'bun:test';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { AssistantMessage, UserMessage } from '../../common/chat-types.js';
import {
  historyPage,
  projectionAppender,
  testProjectionState,
  transcriptSnapshot,
} from '../chats/__tests__/chat-transcript-test-helpers.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content, metadata = {}) {
  return new UserMessage(TS, content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function contents(result) {
  return result.messages.map((entry) => entry.message.content);
}

describe('chat stream resume integration', () => {
  it('replays missed same-generation output after reconnect', async () => {
    const views = new ChatViewStore(() => false);
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };
    const append = projectionAppender(views, 'chat-1');

    await append([user('hello', { ...turn, deliveryStatus: 'accepted' })]);
    const first = await append([assistant('first')]);
    const cursor = { generationId: first.generationId, lastSeq: first.lastSeq };

    await append([assistant('missed')]);

    const replay = views.readReplay('chat-1', cursor.generationId, cursor.lastSeq);

    expect(replay.mode).toBe('delta');
    expect(contents(replay)).toEqual(['missed']);
    expect(replay.lastSeq).toBe(3);
  });

  it('retains the most recently subscribed idle chat for same-generation replay', async () => {
    let now = 0;
    const views = new ChatViewStore(() => false, {
      recentViewRetentionCount: 1,
      staleNonActiveMs: 10,
      now: () => now,
    });
    const appendWatched = projectionAppender(views, 'chat-1');
    const watched = await appendWatched([assistant('first')]);
    await projectionAppender(views, 'chat-2')([assistant('other')]);
    views.readReplay('chat-1', watched.generationId, watched.lastSeq);

    now = 11;
    views.prune();
    expect(views.getCursor('chat-2')).toBeNull();
    await appendWatched([assistant('missed')]);

    const replay = views.readReplay('chat-1', watched.generationId, watched.lastSeq);
    expect(replay.mode).toBe('delta');
    expect(contents(replay)).toEqual(['missed']);
  });

  it('relists into a fresh generation and ignores an already-applied late commit', async () => {
    const views = new ChatViewStore(() => false);
    const history = [assistant('durable one'), assistant('durable two')];
    const currentState = testProjectionState(2);
    const loader = {
      loadAll: async () => transcriptSnapshot(history, { projectionState: currentState }),
      loadPage: async (limit, offset) => (
        historyPage(history, limit, offset, { projectionState: currentState })
      ),
    };
    const stale = await views.getOrCreatePage('chat-1', {
      loadAll: async () => transcriptSnapshot([assistant('durable one')], {
        projectionState: testProjectionState(1, { epoch: 'stream-epoch-0' }),
      }),
    }, 20);

    const relisted = await views.applyProjectionCommit('chat-1', {
      previousProjection: testProjectionState(1),
      checkpointProjection: currentState,
      appendedMessages: [assistant('durable two')],
      carryOverMessageCount: 0,
    }, loader);
    expect(relisted.kind).toBe('relisted');
    expect(relisted.generationId).not.toBe(stale.generationId);

    const late = await views.applyProjectionCommit('chat-1', {
      previousProjection: testProjectionState(1),
      checkpointProjection: currentState,
      appendedMessages: [assistant('durable two')],
      carryOverMessageCount: 0,
    }, loader);
    expect(late.kind).toBe('already-applied');
    expect(contents(views.readPage('chat-1', 20))).toEqual(['durable one', 'durable two']);
  });
});

import { describe, expect, it, mock } from 'bun:test';
import { ChatViewStore } from '../chat-view-store.js';
import { ChatRunningError } from '../errors.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import {
  historyPage,
  projectionAppender,
  snapshotLoader,
  testProjectionState,
  transcriptSnapshot,
} from './chat-transcript-test-helpers.js';

const TS = '2026-06-01T00:00:00.000Z';

function user(content) {
  return new UserMessage(TS, content);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function contents(page) {
  return page.messages.map((entry) => entry.message.content);
}

describe('ChatViewStore.reloadFromProjection', () => {
  it('replaces the generation with the authoritative projection window', async () => {
    const views = new ChatViewStore(() => false);
    const before = await projectionAppender(views, 'chat-1')([user('old view row')]);
    const current = [user('ledger prompt'), assistant('ledger reply')];
    const state = testProjectionState(2);
    const loadPage = mock(async (limit, offset) => (
      historyPage(current, limit, offset, { projectionState: state })
    ));

    const reload = await views.reloadFromProjection('chat-1', {
      loadAll: snapshotLoader(async () => current, { projectionState: state }),
      loadPage,
    });

    expect(reload.generationId).not.toBe(before.generationId);
    expect(contents(reload)).toEqual(['ledger prompt', 'ledger reply']);
    expect(reload.lastSeq).toBe(2);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(views.getCursor('chat-1')?.generationId).toBe(reload.generationId);
  });

  it('rejects a reload while execution owns the chat without reading', async () => {
    const views = new ChatViewStore(() => true);
    const loadAll = mock(async () => transcriptSnapshot([assistant('unused')]));

    await expect(views.reloadFromProjection('chat-1', { loadAll }))
      .rejects.toBeInstanceOf(ChatRunningError);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('rechecks ownership after a held read before replacing the view', async () => {
    let active = false;
    let releaseRead;
    const readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const views = new ChatViewStore(() => active);
    const original = await projectionAppender(views, 'chat-1')([assistant('original')]);

    const reloadPromise = views.reloadFromProjection('chat-1', {
      loadAll: async () => {
        await readGate;
        return transcriptSnapshot([assistant('late replacement')]);
      },
    });
    active = true;
    releaseRead();

    await expect(reloadPromise).rejects.toBeInstanceOf(ChatRunningError);
    expect(views.readPage('chat-1', 20)).toMatchObject({
      generationId: original.generationId,
      messages: [expect.objectContaining({
        message: expect.objectContaining({ content: 'original' }),
      })],
    });
  });
});

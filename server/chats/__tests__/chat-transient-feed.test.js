import { describe, expect, it } from 'bun:test';
import { BashToolUseMessage } from '../../../common/chat-types.ts';
import {
  ChatTransientFeedStore,
  TransientControlActionError,
} from '../chat-transient-feed.ts';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-11T00:00:00.000Z';

function permissionEvent({
  kind = 'requested',
  requestId = 'permission-1',
  incarnation = 'one',
  runId = 'run-1',
  ordinal = 3,
  viewId = 'view-1',
} = {}) {
  const lifecycle = kind === 'requested'
    ? {
        kind,
        requestId,
        incarnation,
        requestedTool: new BashToolUseMessage(TIMESTAMP, `tool-${requestId}`, 'bun test'),
        options: [],
      }
    : kind === 'cancelled'
      ? { kind, requestId, incarnation, reason: null }
      : { kind, requestId, incarnation };
  return {
    type: 'permission',
    chatId: CHAT_ID,
    viewId,
    runId,
    row: {
      kind: `permission-${kind}`,
      ordinal,
      at: TIMESTAMP,
      providerMeta: null,
      lifecycle,
    },
  };
}

function runEndedEvent(runId = 'run-1', ordinal = 4) {
  return {
    type: 'run-ended',
    chatId: CHAT_ID,
    viewId: 'view-1',
    runId,
    row: {
      kind: 'run-ended',
      ordinal,
      at: TIMESTAMP,
      providerMeta: null,
      outcome: 'finished',
      origin: 'provider',
    },
  };
}

function action(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    runId: 'run-1',
    id: 'permission-1',
    incarnation: 'one',
    ...overrides,
  };
}

describe('ChatTransientFeedStore', () => {
  it('projects a durable permission request and fences its actionability', () => {
    const feed = new ChatTransientFeedStore('server-1');

    expect(feed.apply(permissionEvent())).toMatchObject({
      kind: 'mutation',
      value: {
        transcriptViewId: 'view-1',
        transientRevision: 1,
        mutation: {
          kind: 'upsert',
          row: {
            id: 'permission-1',
            incarnation: 'one',
            runId: 'run-1',
            transcript: { transcriptViewId: 'view-1', afterOrdinal: 3 },
          },
        },
      },
    });
    expect(feed.validateAction(action())).toMatchObject({ id: 'permission-1' });

    expect(feed.apply(permissionEvent({ kind: 'cancelled', ordinal: 4 }))).toMatchObject({
      kind: 'mutation',
      value: { transientRevision: 2, mutation: { kind: 'remove' } },
    });
    expect(() => feed.validateAction(action())).toThrow(TransientControlActionError);
  });

  it('clears only controls correlated with the run that ended', () => {
    const feed = new ChatTransientFeedStore('server-1');
    feed.apply(permissionEvent());
    feed.apply(permissionEvent({
      requestId: 'permission-2',
      incarnation: 'two',
      runId: 'run-2',
      ordinal: 4,
    }));

    expect(feed.apply(runEndedEvent('run-1', 5))).toMatchObject({
      kind: 'mutation',
      value: { mutation: { kind: 'clear-run', runId: 'run-1' } },
    });
    expect(feed.currentSnapshot(CHAT_ID)?.rows).toMatchObject([
      { id: 'permission-2', runId: 'run-2' },
    ]);
    expect(feed.apply(runEndedEvent('unknown', 6))).toEqual({ kind: 'unchanged' });
  });

  it('resets ephemeral controls when the transcript view is replaced', () => {
    const feed = new ChatTransientFeedStore('server-1');
    feed.apply(permissionEvent());

    expect(feed.apply({
      type: 'view-replaced',
      chatId: CHAT_ID,
      previousViewId: 'view-1',
      view: {
        viewId: 'view-2',
        createdAt: TIMESTAMP,
        contentStartOrdinal: 1,
      },
    })).toEqual({ kind: 'unchanged' });
    expect(feed.currentSnapshot(CHAT_ID)).toEqual({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      transcriptViewId: 'view-2',
      transientRevision: 0,
      rows: [],
    });
  });

  it('keeps empty snapshots read-only before the first lifecycle mutation', () => {
    const feed = new ChatTransientFeedStore('server-1');

    expect(feed.snapshot({ chatId: CHAT_ID, transcriptViewId: 'view-1' })).toEqual({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    });
    expect(feed.currentSnapshot(CHAT_ID)).toBeNull();
    expect(feed.apply({
      type: 'rows',
      chatId: CHAT_ID,
      viewId: 'view-1',
      rows: [],
    })).toEqual({ kind: 'unchanged' });
    expect(feed.currentSnapshot(CHAT_ID)).toBeNull();
  });

  it('rejects stale server, run, and incarnation action fences', () => {
    const feed = new ChatTransientFeedStore('server-1');
    feed.apply(permissionEvent());

    for (const candidate of [
      action({ serverInstanceId: 'server-2' }),
      action({ runId: 'run-2' }),
      action({ incarnation: 'two' }),
    ]) {
      expect(() => feed.validateAction(candidate)).toThrow(TransientControlActionError);
    }
  });
});

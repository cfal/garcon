import { describe, expect, it } from 'bun:test';
import {
  parseChatTransientControlAction,
  parseChatTransientFeedMutation,
  parseChatTransientFeedSnapshot,
} from '../chat-transient-feed.ts';

const CHAT_ID = '1785337200123456';

function row(overrides = {}) {
  return {
    id: 'permission-1',
    incarnation: 'incarnation-1',
    runId: 'run-1',
    transcript: { transcriptViewId: 'view-1', afterOrdinal: 3 },
    displayOrder: 0,
    message: {
      type: 'permission-request',
      timestamp: '2026-08-11T00:00:00.000Z',
      permissionRequestId: 'permission-1',
      requestedTool: {
        type: 'bash-tool-use',
        timestamp: '2026-08-11T00:00:00.000Z',
        toolId: 'tool-1',
        command: 'bun test',
      },
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    transcriptViewId: 'view-1',
    transientRevision: 1,
    rows: [row()],
    ...overrides,
  };
}

describe('chat transient feed contracts', () => {
  it('parses snapshots, mutations, and action fences', () => {
    expect(parseChatTransientFeedSnapshot(snapshot())).toMatchObject({
      transcriptViewId: 'view-1',
      rows: [{ id: 'permission-1', runId: 'run-1' }],
    });
    expect(parseChatTransientFeedMutation({
      ...snapshot({ rows: undefined }),
      mutation: { kind: 'upsert', row: row() },
    })).toMatchObject({ mutation: { kind: 'upsert', row: { id: 'permission-1' } } });
    expect(parseChatTransientFeedMutation({
      ...snapshot({ rows: undefined }),
      mutation: { kind: 'clear-run', runId: 'run-1' },
    })).toMatchObject({ mutation: { kind: 'clear-run', runId: 'run-1' } });
    expect(parseChatTransientControlAction({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      runId: 'run-1',
      id: 'permission-1',
      incarnation: 'incarnation-1',
    })).toEqual({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      runId: 'run-1',
      id: 'permission-1',
      incarnation: 'incarnation-1',
    });
  });

  it('rejects duplicate slots even when their incarnations differ', () => {
    expect(parseChatTransientFeedSnapshot(snapshot({
      rows: [row(), row({ incarnation: 'incarnation-2' })],
    }))).toBeNull();
  });

  it('rejects view mismatches and incomplete action fences', () => {
    expect(parseChatTransientFeedMutation({
      ...snapshot({ rows: undefined }),
      mutation: {
        kind: 'upsert',
        row: row({ transcript: { transcriptViewId: 'view-2', afterOrdinal: 3 } }),
      },
    })).toBeNull();
    expect(parseChatTransientFeedSnapshot(snapshot({
      rows: [row({ runId: '' })],
    }))).toBeNull();
    expect(parseChatTransientControlAction({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      runId: '',
      id: 'permission-1',
      incarnation: 'incarnation-1',
    })).toBeNull();
  });
});

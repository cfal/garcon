import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { PaginatedCodexHistorySource } from '../paginated-history-source.ts';

const profile = {
  mode: 'paginated',
  nativePath: '/tmp/sanitized-rollout.jsonl',
  threadId: 'thread-1',
  createdAt: '2026-07-20T00:00:00.000Z',
  historyBase: null,
};

const noEvidence = async () => ({ messages: [], orderedItemIdsByTurn: new Map() });

function turn(id, startedAt) {
  return {
    id,
    items: [],
    itemsView: 'notLoaded',
    status: 'completed',
    error: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
  };
}

function entry(turnId, item) {
  return { turnId, item };
}

function clientForPages(turnPages, itemPages, shutdown = mock()) {
  return {
    listThreadTurns: mock(async ({ cursor }) => turnPages.get(cursor ?? 'first')),
    listThreadItems: mock(async ({ cursor }) => itemPages.get(cursor ?? 'first')),
    shutdown,
  };
}

function onePage(data) {
  return new Map([['first', { data, nextCursor: null, backwardsCursor: null }]]);
}

describe('PaginatedCodexHistorySource', () => {
  it('hydrates turn shells and item pages while preserving provider-global item order', async () => {
    const turnPages = new Map([
      ['first', {
        data: [turn('turn-1', 1_753_056_000), turn('turn-2', 1_753_056_001)],
        nextCursor: 'turn-page-2',
        backwardsCursor: null,
      }],
      ['turn-page-2', {
        data: [turn('turn-3', null)],
        nextCursor: null,
        backwardsCursor: 'first',
      }],
    ]);
    const itemPages = new Map([
      ['first', {
        data: [
          entry('turn-1', {
            type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }],
          }),
          entry('turn-2', {
            type: 'commandExecution', id: 'command-1', command: "/bin/zsh -lc 'pwd'", cwd: '/repo',
            processId: null, source: 'agent', status: 'completed', commandActions: [],
            aggregatedOutput: '/repo', exitCode: 0, durationMs: 4,
          }),
        ],
        nextCursor: 'item-page-2',
        backwardsCursor: null,
      }],
      ['item-page-2', {
        data: [
          entry('turn-1', {
            type: 'agentMessage', id: 'assistant-late', text: 'late answer', phase: null, memoryCitation: null,
          }),
          entry('turn-3', {
            type: 'agentMessage', id: 'assistant-3', text: 'done', phase: null, memoryCitation: null,
          }),
        ],
        nextCursor: null,
        backwardsCursor: 'first',
      }],
    ]);
    const shutdown = mock();
    const client = clientForPages(turnPages, itemPages, shutdown);
    const source = new PaginatedCodexHistorySource(profile, () => client, noEvidence);

    const messages = await source.load(new AbortController().signal);

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'bash-tool-use',
      'tool-result',
      'assistant-message',
      'assistant-message',
    ]);
    expect(messages.map((message) => message.content ?? message.command)).toEqual([
      'hello',
      'pwd',
      { raw: '/repo' },
      'late answer',
      'done',
    ]);
    expect(client.listThreadTurns.mock.calls.map(([request]) => request)).toEqual([
      { threadId: 'thread-1', cursor: null, limit: 100, sortDirection: 'asc', itemsView: 'notLoaded' },
      { threadId: 'thread-1', cursor: 'turn-page-2', limit: 100, sortDirection: 'asc', itemsView: 'notLoaded' },
    ]);
    expect(client.listThreadItems.mock.calls.map(([request]) => request)).toEqual([
      { threadId: 'thread-1', turnId: null, cursor: null, limit: 100, sortDirection: 'asc' },
      { threadId: 'thread-1', turnId: null, cursor: 'item-page-2', limit: 100, sortDirection: 'asc' },
    ]);
    expect(getNativeMessageSource(messages[0])).toEqual({ entryId: 'turn:turn-1:item:user-1' });
    expect(getNativeMessageSource(messages[1])).toEqual({ entryId: 'turn:turn-2:item:command-1' });
    expect(messages[4].timestamp).toBe(profile.createdAt);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it.each(['turn', 'item'])('fails repeated %s cursors and always shuts down', async (kind) => {
    const repeatedPages = new Map([
      ['first', { data: [], nextCursor: 'repeat', backwardsCursor: null }],
      ['repeat', { data: [], nextCursor: 'repeat', backwardsCursor: null }],
    ]);
    const shutdown = mock();
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(
        kind === 'turn' ? repeatedPages : onePage([turn('turn-1', 1_753_056_000)]),
        kind === 'item' ? repeatedPages : onePage([]),
        shutdown,
      ),
      noEvidence,
    );

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
      details: { operation: 'load-paginated-history', provider: 'codex' },
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('enforces the page limit independently for turn and item scans', async () => {
    const continuingPages = new Map([
      ['first', { data: [], nextCursor: 'page-2', backwardsCursor: null }],
      ['page-2', { data: [], nextCursor: 'page-3', backwardsCursor: null }],
    ]);
    const shutdown = mock();
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(continuingPages, onePage([]), shutdown),
      noEvidence,
      2,
    );

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an item refers to an unknown turn', async () => {
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(
        onePage([turn('turn-1', 1_753_056_000)]),
        onePage([entry('turn-missing', {
          type: 'agentMessage', id: 'assistant-1', text: 'orphan', phase: null, memoryCitation: null,
        })]),
      ),
      noEvidence,
    );

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
  });

  it('tolerates a turn appended between the item and turn scans', async () => {
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(
        onePage([turn('turn-1', 1_753_056_000), turn('turn-2', 1_753_056_002)]),
        onePage([entry('turn-1', {
          type: 'agentMessage', id: 'assistant-1', text: 'before the race', phase: null, memoryCitation: null,
        })]),
      ),
      noEvidence,
    );

    const messages = await source.load(new AbortController().signal);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'assistant-message', content: 'before the race' });
  });

  it('supplements an itemless turn with exact client ids from rollout evidence', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-evidence-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    await fs.writeFile(nativePath, [
      JSON.stringify({
        timestamp: '2026-07-20T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'thread-1', timestamp: '2026-07-20T00:00:00.000Z' },
      }),
      JSON.stringify({
        timestamp: '2026-07-20T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          completed_at_ms: 1_753_056_001_000,
          item: {
            type: 'UserMessage',
            id: 'user-steer-1',
            client_id: 'message-steer-1',
            content: [{ type: 'text', text: 'focus here' }],
          },
        },
      }),
    ].join('\n'));
    const source = new PaginatedCodexHistorySource(
      { ...profile, nativePath },
      () => clientForPages(onePage([turn('turn-1', 1_753_056_001)]), onePage([])),
    );

    try {
      const messages = await source.load(new AbortController().signal);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'user-message',
        content: 'focus here',
        metadata: { upstreamRequestId: 'message-steer-1' },
      });
      expect(getNativeMessageSource(messages[0])).toEqual({
        entryId: 'turn:turn-1:item:user-steer-1',
        byteOffset: expect.any(Number),
        lineNumber: 2,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('loads inherited profiles through the leaf thread id', async () => {
    const client = clientForPages(
      onePage([turn('turn-inherited', 1_753_056_000)]),
      onePage([entry('turn-inherited', {
        type: 'agentMessage', id: 'assistant-1', text: 'flattened history', phase: null, memoryCitation: null,
      })]),
    );
    const source = new PaginatedCodexHistorySource({
      ...profile,
      historyBase: { threadId: 'thread-parent', endOrdinalExclusive: 2, endByteOffset: 50 },
    }, () => client, noEvidence);

    await expect(source.load(new AbortController().signal)).resolves.toMatchObject([
      { type: 'assistant-message', content: 'flattened history' },
    ]);
    expect(client.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
    }));
    expect(client.listThreadItems).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1',
    }));
  });

  it.each(['missing base', 'malformed base', 'cyclic base'])(
    'surfaces provider lineage failure for %s',
    async (failure) => {
      const source = new PaginatedCodexHistorySource(
        { ...profile, historyBase: { threadId: 'thread-parent', endOrdinalExclusive: 2, endByteOffset: 50 } },
        () => ({
          listThreadItems: mock(async () => { throw new Error(failure); }),
          listThreadTurns: mock(async () => { throw new Error('must not list turns'); }),
          shutdown: mock(),
        }),
        noEvidence,
      );

      await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
      });
    },
  );

  it('stops between page scans after abort and shuts down', async () => {
    const controller = new AbortController();
    const shutdown = mock();
    const listThreadItems = mock(async () => {
      controller.abort(new Error('stop history'));
      return { data: [], nextCursor: null, backwardsCursor: null };
    });
    const listThreadTurns = mock(async () => ({ data: [], nextCursor: null, backwardsCursor: null }));
    const source = new PaginatedCodexHistorySource(
      profile,
      () => ({ listThreadTurns, listThreadItems, shutdown }),
      noEvidence,
    );

    await expect(source.load(controller.signal)).rejects.toThrow('stop history');
    expect(listThreadItems).toHaveBeenCalledTimes(1);
    expect(listThreadTurns).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

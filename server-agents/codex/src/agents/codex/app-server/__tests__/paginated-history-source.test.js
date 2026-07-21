import { describe, expect, it, mock } from 'bun:test';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { transcriptRevision } from '@garcon/server-agent-common/lib/transcript-revision';
import { PaginatedCodexHistorySource } from '../paginated-history-source.ts';

const profile = {
  mode: 'paginated',
  nativePath: '/tmp/sanitized-rollout.jsonl',
  threadId: 'thread-1',
  createdAt: '2026-07-20T00:00:00.000Z',
  historyBase: null,
};

function turn(id, items, startedAt) {
  return {
    id,
    items,
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
  };
}

function clientForPages(pages, shutdown = mock()) {
  return {
    listThreadTurns: mock(async ({ cursor }) => pages.get(cursor ?? 'first')),
    shutdown,
  };
}

describe('PaginatedCodexHistorySource', () => {
  it('consumes every full turn page and uses the canonical item converter', async () => {
    const pages = new Map([
      ['first', {
        data: [turn('turn-1', [
          { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'sleep', id: 'sleep-1', durationMs: 250 },
        ], 1_753_056_000)],
        nextCursor: 'page-2', backwardsCursor: null,
      }],
      ['page-2', {
        data: [turn('turn-2', [{
          type: 'commandExecution', id: 'command-1', command: "/bin/zsh -lc 'pwd'", cwd: '/repo',
          processId: null, source: 'agent', status: 'completed', commandActions: [],
          aggregatedOutput: '/repo', exitCode: 0, durationMs: 4,
        }], 1_753_056_001)],
        nextCursor: 'page-3', backwardsCursor: 'first',
      }],
      ['page-3', {
        data: [turn('turn-3', [{
          type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null,
        }], null)],
        nextCursor: null, backwardsCursor: 'page-2',
      }],
    ]);
    const shutdown = mock();
    const clients = [];
    const source = new PaginatedCodexHistorySource(profile, () => {
      const client = clientForPages(pages, shutdown);
      clients.push(client);
      return client;
    });

    const messages = await source.load(new AbortController().signal);

    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'bash-tool-use',
      'tool-result',
      'assistant-message',
    ]);
    expect(clients[0].listThreadTurns.mock.calls.map(([request]) => request)).toEqual([
      { threadId: 'thread-1', cursor: null, limit: 100, sortDirection: 'asc', itemsView: 'full' },
      { threadId: 'thread-1', cursor: 'page-2', limit: 100, sortDirection: 'asc', itemsView: 'full' },
      { threadId: 'thread-1', cursor: 'page-3', limit: 100, sortDirection: 'asc', itemsView: 'full' },
    ]);
    expect(getNativeMessageSource(messages[0])).toEqual({ entryId: 'turn:turn-1:item:user-1' });
    expect(getNativeMessageSource(messages[1])).toEqual({ entryId: 'turn:turn-2:item:command-1' });
    expect(getNativeMessageSource(messages[2])).toEqual({ entryId: 'turn:turn-2:item:command-1' });
    expect(messages[1]).toMatchObject({ type: 'bash-tool-use', command: 'pwd' });
    expect(messages[3].timestamp).toBe(profile.createdAt);
    expect(shutdown).toHaveBeenCalledTimes(1);

    const page = await source.loadPage({ limit: 2, offset: 1 }, new AbortController().signal);
    expect(page.messages).toEqual(messages.slice(1, 3));
    expect(page).toMatchObject({ total: 4, hasMore: true, offset: 1, limit: 2 });
    expect(page.revision).toBe(transcriptRevision(messages));
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it('fails repeated cursors and always shuts down the client', async () => {
    const shutdown = mock();
    const source = new PaginatedCodexHistorySource(profile, () => clientForPages(new Map([
      ['first', { data: [], nextCursor: 'repeat', backwardsCursor: null }],
      ['repeat', { data: [], nextCursor: 'repeat', backwardsCursor: null }],
    ]), shutdown));

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('uses the newest rendered item timestamp for preview activity', async () => {
    const pages = new Map([['first', {
      data: [
        turn('turn-1', [
          { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agentMessage', id: 'assistant-1', text: 'done', phase: null, memoryCitation: null },
        ], 1_753_056_000),
        turn('turn-2', [{
          type: 'commandExecution', id: 'command-1', command: 'pwd', cwd: '/repo',
          processId: null, source: 'agent', status: 'completed', commandActions: [],
          aggregatedOutput: '/repo', exitCode: 0, durationMs: 4,
        }], 1_753_056_100),
      ],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const source = new PaginatedCodexHistorySource(profile, () => clientForPages(pages));

    await expect(source.preview(new AbortController().signal)).resolves.toEqual({
      firstMessage: 'hello',
      lastMessage: 'done',
      createdAt: profile.createdAt,
      lastActivity: '2025-07-21T00:01:40.000Z',
    });
  });

  it('stops requesting pages after abort and shuts down', async () => {
    const controller = new AbortController();
    const shutdown = mock();
    const listThreadTurns = mock(async () => {
      controller.abort(new Error('stop history'));
      return { data: [], nextCursor: 'unused', backwardsCursor: null };
    });
    const source = new PaginatedCodexHistorySource(profile, () => ({ listThreadTurns, shutdown }));

    await expect(source.load(controller.signal)).rejects.toThrow('stop history');
    expect(listThreadTurns).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

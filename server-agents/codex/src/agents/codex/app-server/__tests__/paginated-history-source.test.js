import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import {
  attachNativeMessageSource,
  getNativeMessageSource,
} from '@garcon/server-agent-common/shared/native-message-source';
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
    }, async () => ({ messages: [], orderedItemIdsByTurn: new Map() }));

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
    ]), shutdown), async () => ({ messages: [], orderedItemIdsByTurn: new Map() }));

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      message: 'Codex paginated history is unavailable',
      retryable: true,
      details: {
        operation: 'load-paginated-history',
        provider: 'codex',
        reason: 'provider-error',
      },
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
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(pages),
      async () => ({ messages: [], orderedItemIdsByTurn: new Map() }),
    );

    await expect(source.preview(new AbortController().signal)).resolves.toEqual({
      firstMessage: 'hello',
      lastMessage: 'done',
      createdAt: profile.createdAt,
      lastActivity: '2025-07-21T00:01:40.000Z',
    });
  });

  it('preserves provider turn order when a turn has no timestamps', async () => {
    const pages = new Map([['first', {
      data: [
        turn('turn-1', [{
          type: 'agentMessage', id: 'assistant-1', text: 'first turn', phase: null, memoryCitation: null,
        }], 1_753_056_000),
        turn('turn-2', [{
          type: 'agentMessage', id: 'assistant-2', text: 'second turn', phase: null, memoryCitation: null,
        }], null),
      ],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const source = new PaginatedCodexHistorySource(
      { ...profile, createdAt: '2020-01-01T00:00:00.000Z' },
      () => clientForPages(pages),
      async () => ({ messages: [], orderedItemIdsByTurn: new Map() }),
    );

    const messages = await source.load(new AbortController().signal);

    expect(messages.map((message) => message.content)).toEqual(['first turn', 'second turn']);
  });

  it('inserts omitted user evidence at its exact persisted item position', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-order-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    const itemCompleted = (item, completedAtMs) => JSON.stringify({
      timestamp: new Date(completedAtMs).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        completed_at_ms: completedAtMs,
        item,
      },
    });
    await fs.writeFile(nativePath, [
      itemCompleted({
        type: 'UserMessage',
        id: 'user-1',
        client_id: 'request-1',
        content: [{ type: 'text', text: 'run this' }],
      }, 1_753_056_001_000),
      itemCompleted({ type: 'CommandExecution', id: 'command-1' }, 1_753_056_002_000),
      itemCompleted({ type: 'AgentMessage', id: 'assistant-1' }, 1_753_056_003_000),
    ].join('\n'));
    const pages = new Map([['first', {
      data: [turn('turn-1', [
        {
          type: 'commandExecution', id: 'command-1', command: 'printf done', cwd: '/repo',
          processId: null, source: 'agent', status: 'completed', commandActions: [],
          aggregatedOutput: 'done', exitCode: 0, durationMs: 4,
        },
        {
          type: 'agentMessage', id: 'assistant-1', text: 'finished', phase: null, memoryCitation: null,
        },
      ], null)],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const source = new PaginatedCodexHistorySource(
      { ...profile, nativePath, createdAt: '2020-01-01T00:00:00.000Z' },
      () => clientForPages(pages),
    );

    try {
      const messages = await source.load(new AbortController().signal);

      expect(messages.map((message) => message.type)).toEqual([
        'user-message',
        'bash-tool-use',
        'tool-result',
        'assistant-message',
      ]);
      expect(messages.map((message) => (
        getNativeMessageSource(message)?.entryId
      ))).toEqual([
        'turn:turn-1:item:user-1',
        'turn:turn-1:item:command-1',
        'turn:turn-1:item:command-1',
        'turn:turn-1:item:assistant-1',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects omitted evidence whose position is ambiguous beside an unobserved provider item', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-partial-order-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    const itemCompleted = (item, completedAtMs) => JSON.stringify({
      timestamp: new Date(completedAtMs).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        completed_at_ms: completedAtMs,
        item,
      },
    });
    await fs.writeFile(nativePath, [
      itemCompleted({ type: 'AgentMessage', id: 'assistant-before' }, 1_753_056_001_000),
      itemCompleted({
        type: 'UserMessage',
        id: 'user-omitted',
        client_id: 'request-omitted',
        content: [{ type: 'text', text: 'omitted user' }],
      }, 1_753_056_003_000),
      itemCompleted({ type: 'AgentMessage', id: 'assistant-after' }, 1_753_056_004_000),
    ].join('\n'));
    const pages = new Map([['first', {
      data: [turn('turn-1', [
        {
          type: 'agentMessage', id: 'assistant-before', text: 'before', phase: null, memoryCitation: null,
        },
        {
          type: 'commandExecution', id: 'command-without-evidence', command: 'printf middle', cwd: '/repo',
          processId: null, source: 'agent', status: 'completed', commandActions: [],
          aggregatedOutput: 'middle', exitCode: 0, durationMs: 4,
        },
        {
          type: 'agentMessage', id: 'assistant-after', text: 'after', phase: null, memoryCitation: null,
        },
      ], null)],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const source = new PaginatedCodexHistorySource(
      { ...profile, nativePath },
      () => clientForPages(pages),
    );

    try {
      await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects omitted evidence when native and persisted item order have no shared anchor', async () => {
    const pages = new Map([['first', {
      data: [turn('turn-1', [{
        type: 'agentMessage', id: 'provider-assistant', text: 'provider', phase: null, memoryCitation: null,
      }], null)],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const evidence = attachNativeMessageSource(
      new UserMessage(
        '2026-07-20T00:00:00.000Z',
        'unanchored user',
        undefined,
        { upstreamRequestId: 'unanchored-request' },
      ),
      { entryId: 'turn:turn-1:item:evidence-user', withinSourceOrdinal: 0 },
    );
    const source = new PaginatedCodexHistorySource(
      profile,
      () => clientForPages(pages),
      async () => ({
        messages: [evidence],
        orderedItemIdsByTurn: new Map([['turn-1', ['evidence-user']]]),
      }),
    );

    await expect(source.load(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
  });

  it('deduplicates omitted user evidence only by exact upstream request identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-request-id-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    await fs.writeFile(nativePath, JSON.stringify({
      timestamp: '2026-07-20T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        completed_at_ms: 1_753_056_001_000,
        item: {
          type: 'UserMessage',
          id: 'evidence-user',
          client_id: 'request-1',
          content: [{ type: 'text', text: 'different evidence text' }],
        },
      },
    }));
    const pages = new Map([['first', {
      data: [turn('turn-1', [{
        type: 'userMessage',
        id: 'provider-user',
        clientId: 'request-1',
        content: [{ type: 'text', text: 'provider text' }],
      }], 1_753_056_001)],
      nextCursor: null,
      backwardsCursor: null,
    }]]);
    const source = new PaginatedCodexHistorySource(
      { ...profile, nativePath },
      () => clientForPages(pages),
    );

    try {
      const messages = await source.load(new AbortController().signal);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'user-message',
        content: 'provider text',
        metadata: { upstreamRequestId: 'request-1' },
      });
      expect(getNativeMessageSource(messages[0])?.entryId).toBe(
        'turn:turn-1:item:provider-user',
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('supplements paginated history with exact client ids from rollout item events', async () => {
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
      () => clientForPages(new Map([['first', {
        data: [turn('turn-1', [], 1_753_056_001)],
        nextCursor: null,
        backwardsCursor: null,
      }]])),
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

  it('excludes raw user-message evidence for turns removed from native history', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-evidence-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    const userMessage = (turnId, id, clientId, text) => JSON.stringify({
      timestamp: '2026-07-20T00:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: 'thread-1',
        turn_id: turnId,
        completed_at_ms: 1_753_056_001_000,
        item: {
          type: 'UserMessage',
          id,
          client_id: clientId,
          content: [{ type: 'text', text }],
        },
      },
    });
    await fs.writeFile(nativePath, [
      userMessage('turn-surviving', 'user-surviving', 'message-surviving', 'keep this'),
      userMessage('turn-rolled-back', 'user-rolled-back', 'message-rolled-back', 'remove this'),
      JSON.stringify({
        timestamp: '2026-07-20T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      }),
    ].join('\n'));
    const source = new PaginatedCodexHistorySource(
      { ...profile, nativePath },
      () => clientForPages(new Map([['first', {
        data: [turn('turn-surviving', [], 1_753_056_001)],
        nextCursor: null,
        backwardsCursor: null,
      }]])),
    );

    try {
      const messages = await source.load(new AbortController().signal);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'user-message',
        content: 'keep this',
        metadata: { upstreamRequestId: 'message-surviving' },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('stops requesting pages after abort and shuts down', async () => {
    const controller = new AbortController();
    const shutdown = mock();
    const listThreadTurns = mock(async () => {
      controller.abort(new Error('stop history'));
      return { data: [], nextCursor: 'unused', backwardsCursor: null };
    });
    const source = new PaginatedCodexHistorySource(
      profile,
      () => ({ listThreadTurns, shutdown }),
      async () => ({ messages: [], orderedItemIdsByTurn: new Map() }),
    );

    await expect(source.load(controller.signal)).rejects.toThrow('stop history');
    expect(listThreadTurns).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { QueueManager } from '../../queue.js';

let workspaceDir = '';
let queue;

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-queue-test-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  queue = new QueueManager(workspaceDir);
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('queue invariants', () => {
  it('does not keep paused=true on an empty queue', async () => {
    const result = await queue.pauseChatQueue('123');
    expect(result.entries).toHaveLength(0);
    expect(result.paused).toBe(false);
  });

  it('clears paused when the last queued entry is removed', async () => {
    const { entry } = await queue.enqueueChat('123', 'hello');
    await queue.pauseChatQueue('123');

    const result = await queue.dequeueChat('123', entry.id);
    expect(result.entries).toHaveLength(0);
    expect(result.paused).toBe(false);
  });

  it('normalizes stale queue files where paused=true but entries are empty', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      path.join(queuesDir, '123.queue.json'),
      JSON.stringify({ entries: [], paused: true }),
      'utf8',
    );

    const result = await queue.readChatQueue('123');
    expect(result.entries).toEqual([]);
    expect(result.paused).toBe(false);
  });
});

describe('queue-updated event', () => {
  it('emits on enqueue', async () => {
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.enqueueChat('c1', 'hello');
    expect(events).toHaveLength(1);
    expect(events[0].chatId).toBe('c1');
    expect(events[0].state.entries).toHaveLength(1);
  });

  it('emits on dequeue', async () => {
    const { entry } = await queue.enqueueChat('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.dequeueChat('c1', entry.id);
    expect(events).toHaveLength(1);
    expect(events[0].state.entries).toHaveLength(0);
  });

  it('emits on clear', async () => {
    await queue.enqueueChat('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.clearChatQueue('c1');
    expect(events).toHaveLength(1);
    expect(events[0].state.entries).toHaveLength(0);
  });

  it('emits on pause', async () => {
    await queue.enqueueChat('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.pauseChatQueue('c1');
    expect(events).toHaveLength(1);
    expect(events[0].state.paused).toBe(true);
  });

  it('emits on resume', async () => {
    await queue.enqueueChat('c1', 'hello');
    await queue.pauseChatQueue('c1');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.resumeChatQueue('c1');
    expect(events).toHaveLength(1);
    expect(events[0].state.paused).toBe(false);
  });
});

describe('orchestration', () => {
  let mockProviders;
  let mockHistoryCache;
  let orchQueue;

  beforeEach(async () => {
    mockProviders = {
      runProviderTurn: mock(() => Promise.resolve()),
      abortSession: mock(() => Promise.resolve(true)),
      isChatRunning: mock(() => false),
    };
    mockHistoryCache = {
      appendMessages: mock(() => Promise.resolve()),
    };
    orchQueue = new QueueManager(workspaceDir, mockProviders, mockHistoryCache);
  });

  describe('submit', () => {
    it('runs provider turn with the given command', async () => {
      await orchQueue.submit('c1', 'hello', { permissionMode: 'default' });
      expect(mockProviders.runProviderTurn).toHaveBeenCalledWith('c1', 'hello', { permissionMode: 'default' });
    });

    it('appends user message to history cache', async () => {
      await orchQueue.submit('c1', 'hello', {});
      expect(mockHistoryCache.appendMessages).toHaveBeenCalledWith('c1', [
        expect.objectContaining({ type: 'user-message', content: 'hello' }),
      ]);
    });

    it('does not append when command is empty', async () => {
      await orchQueue.submit('c1', '', {});
      expect(mockHistoryCache.appendMessages).not.toHaveBeenCalled();
    });

    it('drains queued entries after provider turn', async () => {
      await orchQueue.enqueueChat('c1', 'queued msg');

      await orchQueue.submit('c1', 'initial', {});

      // Initial turn + drain turn
      expect(mockProviders.runProviderTurn).toHaveBeenCalledTimes(2);
      expect(mockProviders.runProviderTurn.mock.calls[1][1]).toBe('queued msg');
    });

    it('propagates provider errors to caller', async () => {
      mockProviders.runProviderTurn.mockRejectedValue(new Error('provider fail'));

      await expect(orchQueue.submit('c1', 'hello', {})).rejects.toThrow('provider fail');
    });
  });

  describe('abort', () => {
    it('calls providers.abortSession', async () => {
      await orchQueue.abort('c1');
      expect(mockProviders.abortSession).toHaveBeenCalledWith('c1');
    });

    it('emits session-stopped event', async () => {
      const events = [];
      orchQueue.onSessionStopped((chatId, success) => events.push({ chatId, success }));

      await orchQueue.abort('c1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ chatId: 'c1', success: true });
    });

    it('pauses queue when entries exist after abort', async () => {
      await orchQueue.enqueueChat('c1', 'pending');

      await orchQueue.abort('c1');
      const result = await orchQueue.readChatQueue('c1');
      expect(result.paused).toBe(true);
    });
  });

  describe('triggerDrain', () => {
    it('is a no-op when provider is running', async () => {
      mockProviders.isChatRunning.mockReturnValue(true);
      await orchQueue.enqueueChat('c1', 'queued');

      await orchQueue.triggerDrain('c1', {});
      expect(mockProviders.runProviderTurn).not.toHaveBeenCalled();
    });

    it('drains queued entries when provider is idle', async () => {
      await orchQueue.enqueueChat('c1', 'queued msg');

      const events = [];
      orchQueue.onDispatching((chatId, entryId, content) => events.push({ chatId, entryId, content }));

      await orchQueue.triggerDrain('c1', {});

      expect(mockProviders.runProviderTurn).toHaveBeenCalledWith('c1', 'queued msg', {});
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('queued msg');
    });
  });

  describe('drain', () => {
    it('emits dispatching for each entry', async () => {
      await orchQueue.enqueueChat('c1', 'msg1');
      // Second enqueue appends to existing entry since status is 'queued'.
      // Use separate chats or pop the first to test sequential drain.
      const events = [];
      orchQueue.onDispatching((chatId, entryId, content) => events.push({ chatId, content }));

      await orchQueue.triggerDrain('c1', {});
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('msg1');
    });

    it('pauses on provider error via resetAndPauseChat', async () => {
      await orchQueue.enqueueChat('c1', 'will fail');

      mockProviders.runProviderTurn.mockRejectedValue(new Error('provider error'));

      await orchQueue.triggerDrain('c1', {});

      const result = await orchQueue.readChatQueue('c1');
      expect(result.paused).toBe(true);
      expect(result.entries[0].status).toBe('queued');
    });

    it('appends queued messages to history cache', async () => {
      await orchQueue.enqueueChat('c1', 'queued text');

      await orchQueue.triggerDrain('c1', {});

      expect(mockHistoryCache.appendMessages).toHaveBeenCalledWith('c1', [
        expect.objectContaining({ type: 'user-message', content: 'queued text' }),
      ]);
    });
  });

  describe('chat-idle event', () => {
    it('fires after drain completes with empty queue', async () => {
      await orchQueue.enqueueChat('c1', 'msg');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1', {});
      expect(idleEvents).toHaveLength(1);
      expect(idleEvents[0]).toBe('c1');
    });

    it('fires after submit drains to empty queue', async () => {
      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.submit('c1', 'hello', {});
      expect(idleEvents).toHaveLength(1);
      expect(idleEvents[0]).toBe('c1');
    });

    it('does NOT fire when drain exits because provider is running', async () => {
      await orchQueue.enqueueChat('c1', 'msg');
      mockProviders.isChatRunning.mockReturnValue(true);

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1', {});
      expect(idleEvents).toHaveLength(0);
    });
  });

  describe('checkChatIdle', () => {
    it('emits chat-idle when queue is empty and provider not running', async () => {
      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');
      expect(idleEvents).toEqual(['c1']);
    });

    it('does NOT emit when provider is running', async () => {
      mockProviders.isChatRunning.mockReturnValue(true);

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');
      expect(idleEvents).toHaveLength(0);
    });

    it('does NOT emit when queue has pending entries', async () => {
      await orchQueue.enqueueChat('c1', 'pending msg');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');
      expect(idleEvents).toHaveLength(0);
    });
  });
});

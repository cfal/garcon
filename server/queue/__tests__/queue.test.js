import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { QueueManager } from '../../queue.js';

let workspaceDir = '';
let queue;

function createStateOnlyAgents() {
  return {
    runAgentTurn: mock(() => Promise.reject(new Error('state-only queue cannot run turns'))),
    abortSession: mock(() => Promise.resolve(false)),
    isChatRunning: mock(() => false),
  };
}

function createPendingInputs() {
  return {
    register: mock(() => Promise.resolve()),
    discard: mock(() => true),
  };
}

function createChatMessages() {
  let seq = 0;
  return {
    appendMessages: mock((_chatId, messages) => {
      const viewMessages = messages.map((message) => {
        seq += 1;
        return {
          seq,
          message,
        };
      });
      return Promise.resolve({ generationId: 'generation-1', messages: viewMessages });
    }),
  };
}

function emptyDrainOptions() {
  return {};
}

beforeEach(async () => {
  workspaceDir = path.join(os.tmpdir(), `garcon-queue-test-${randomUUID()}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  queue = new QueueManager(
    workspaceDir,
    createStateOnlyAgents(),
    createPendingInputs(),
    createChatMessages(),
    emptyDrainOptions,
  );
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

  it('returns defensive queue copies from reads', async () => {
    await queue.enqueueChat('123', 'hello');

    const firstRead = await queue.readChatQueue('123');
    firstRead.entries[0].content = 'mutated externally';

    const secondRead = await queue.readChatQueue('123');
    expect(secondRead.entries[0].content).toBe('hello');
  });

  it('uses cached queue state for later mutations', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      path.join(queuesDir, 'cached.queue.json'),
      JSON.stringify({
        entries: [{
          id: 'entry-1',
          content: 'persisted',
          status: 'queued',
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
        paused: false,
      }),
      'utf8',
    );

    await queue.readChatQueue('cached');
    await fs.writeFile(
      path.join(queuesDir, 'cached.queue.json'),
      JSON.stringify({ entries: [], paused: false }),
      'utf8',
    );

    const result = await queue.pauseChatQueue('cached');
    expect(result.entries.map((entry) => entry.content)).toEqual(['persisted']);
    expect(result.paused).toBe(true);
  });

  it('clears cached state when deleting a queue file', async () => {
    await queue.enqueueChat('123', 'hello');

    await queue.deleteChatQueueFile('123');
    const result = await queue.readChatQueue('123');

    expect(result.entries).toEqual([]);
    expect(result.paused).toBe(false);
  });

  it('bumps version and updatedAt across queue mutations', async () => {
    const first = await queue.enqueueChat('123', 'hello');
    const paused = await queue.pauseChatQueue('123');
    const resumed = await queue.resumeChatQueue('123');

    expect(first.queue.version).toBe(1);
    expect(typeof first.queue.updatedAt).toBe('string');
    expect(paused.version).toBe(2);
    expect(typeof paused.updatedAt).toBe('string');
    expect(resumed.version).toBe(3);
    expect(typeof resumed.updatedAt).toBe('string');
  });

  it('requires execution dependencies at construction', () => {
    expect(() => new QueueManager(workspaceDir)).toThrow(
      'QueueManager requires an agent turn runner',
    );
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
  let mockAgents;
  let mockPendingInputs;
  let mockChatMessages;
  let mockDrainOptions;
  let orchQueue;

  beforeEach(async () => {
    mockAgents = {
      runAgentTurn: mock(() => Promise.resolve()),
      abortSession: mock(() => Promise.resolve(true)),
      isChatRunning: mock(() => false),
    };
    mockPendingInputs = {
      register: mock(() => Promise.resolve()),
      discard: mock(() => true),
    };
    mockChatMessages = createChatMessages();
    mockDrainOptions = mock(() => ({
      permissionMode: 'plan',
      thinkingMode: 'low',
      claudeThinkingMode: 'off',
      ampAgentMode: 'deep',
      model: 'persisted-model',
    }));
    orchQueue = new QueueManager(workspaceDir, mockAgents, mockPendingInputs, mockChatMessages, mockDrainOptions);
  });

  describe('submit', () => {
    it('runs agent turn with the given command', async () => {
      await orchQueue.submit('c1', 'hello', { permissionMode: 'default' });
      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'hello', expect.objectContaining({
        permissionMode: 'default',
        clientRequestId: expect.any(String),
        clientMessageId: expect.any(String),
        turnId: expect.any(String),
      }));
    });

    it('registers pending input for submitted turns', async () => {
      await orchQueue.submit('c1', 'hello', {});
      expect(mockPendingInputs.register).toHaveBeenCalledWith('c1', 'hello', expect.objectContaining({
        clientRequestId: expect.any(String),
        clientMessageId: expect.any(String),
        turnId: expect.any(String),
        deliveryStatus: 'accepted',
      }));
    });

    it('appends the accepted user message and emits chat messages', async () => {
      const batches = [];
      orchQueue.onChatMessages((chatId, generationId, messages, metadata) => {
        batches.push({ chatId, generationId, messages, metadata });
      });

      await orchQueue.submit('c1', 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
      });

      expect(mockChatMessages.appendMessages).toHaveBeenCalledWith(
        'c1',
        [expect.objectContaining({
          content: 'hello',
          metadata: expect.objectContaining({
            clientRequestId: 'req-1',
            turnId: 'turn-1',
            deliveryStatus: 'accepted',
          }),
        })],
      );
      expect(batches[0]).toMatchObject({
        chatId: 'c1',
        generationId: 'generation-1',
        metadata: { clientRequestId: 'req-1', turnId: 'turn-1' },
      });
      expect(batches[0].messages[0].message.content).toBe('hello');
    });

    it('registers provided metadata for accepted REST turns', async () => {
      await orchQueue.registerPendingUserInput('c1', 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
      });

      expect(mockPendingInputs.register).toHaveBeenCalledWith('c1', 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
        images: undefined,
        deliveryStatus: 'accepted',
      });
    });

    it('does not register pending input when command is empty', async () => {
      await orchQueue.submit('c1', '', {});
      expect(mockPendingInputs.register).not.toHaveBeenCalled();
    });

    it('silently discards pending input through the pending service', () => {
      expect(orchQueue.discardPendingUserInput('c1', 'req-1')).toBe(true);
      expect(mockPendingInputs.discard).toHaveBeenCalledWith('c1', 'req-1');
    });

    it('drains queued entries after agent turn', async () => {
      await orchQueue.enqueueChat('c1', 'queued msg');

      await orchQueue.submit('c1', 'initial', {});

      // Initial turn + drain turn
      expect(mockAgents.runAgentTurn).toHaveBeenCalledTimes(2);
      expect(mockAgents.runAgentTurn.mock.calls[1][1]).toBe('queued msg');
    });

    it('propagates agent errors to caller', async () => {
      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent fail'));

      await expect(orchQueue.submit('c1', 'hello', {})).rejects.toThrow('agent fail');
    });

    it('emits turn-failed with command identity when agent execution fails', async () => {
      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent fail'));
      const failures = [];
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      await expect(orchQueue.runAcceptedTurn('c1', 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
      })).rejects.toThrow('agent fail');

      expect(failures).toEqual([{
        chatId: 'c1',
        error: 'agent fail',
        options: {
          clientRequestId: 'req-1',
          clientMessageId: 'msg-1',
          turnId: 'turn-1',
        },
      }]);
    });

    it('does not emit a delivery revision after accepted turns complete', async () => {
      await orchQueue.runAcceptedTurn('c1', 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
      });

      expect(mockChatMessages.appendMessages).not.toHaveBeenCalled();
    });
  });

  describe('abort', () => {
    it('calls turn runner abortSession', async () => {
      await orchQueue.abort('c1');
      expect(mockAgents.abortSession).toHaveBeenCalledWith('c1');
    });

    it('emits session-stop-requested before abortSession', async () => {
      const events = [];
      mockAgents.abortSession.mockImplementation((chatId) => {
        events.push(`abort:${chatId}`);
        return Promise.resolve(true);
      });
      orchQueue.onSessionStopRequested((chatId) => events.push(`requested:${chatId}`));

      await orchQueue.abort('c1');

      expect(events).toEqual(['requested:c1', 'abort:c1']);
    });

    it('emits session-stopped event', async () => {
      const events = [];
      orchQueue.onSessionStopped((chatId, success) => events.push({ chatId, success }));

      await orchQueue.abort('c1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ chatId: 'c1', success: true });
    });

    it('drains queued entries after abort succeeds', async () => {
      await orchQueue.enqueueChat('c1', 'pending');
      const dispatched = new Promise((resolve) => {
        orchQueue.onDispatching((chatId, entryId, content) => resolve({ chatId, entryId, content }));
      });
      const idle = new Promise((resolve) => {
        orchQueue.onChatIdle((chatId) => resolve(chatId));
      });

      await orchQueue.abort('c1');
      const event = await dispatched;
      await idle;

      expect(event).toMatchObject({ chatId: 'c1', content: 'pending' });
      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'pending', expect.any(Object));
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(0);
      expect(result.paused).toBe(false);
    });

    it('allows the queued entry to drain when abort races checkChatIdle', async () => {
      await orchQueue.enqueueChat('c1', 'queued during turn');
      mockAgents.abortSession.mockImplementation(async () => {
        await orchQueue.checkChatIdle('c1');
        return true;
      });

      await orchQueue.abort('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'queued during turn', expect.any(Object));
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(0);
      expect(result.paused).toBe(false);
    });

    it('leaves queued entries untouched when abort fails', async () => {
      await orchQueue.enqueueChat('c1', 'pending');
      mockAgents.abortSession.mockResolvedValue(false);

      await orchQueue.abort('c1');

      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(1);
      expect(result.paused).toBe(false);
    });

    it('leaves queued entries untouched when abort succeeds without drain', async () => {
      await orchQueue.enqueueChat('c1', 'pending');

      await orchQueue.abort('c1', { drainAfterAbort: false });

      expect(mockAgents.abortSession).toHaveBeenCalledWith('c1');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(1);
      expect(result.paused).toBe(false);
    });
  });

  describe('triggerDrain', () => {
    it('is a no-op when agent is running', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      await orchQueue.enqueueChat('c1', 'queued');

      await orchQueue.triggerDrain('c1');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
    });

    it('drains queued entries when agent is idle', async () => {
      await orchQueue.enqueueChat('c1', 'queued msg');

      const events = [];
      orchQueue.onDispatching((chatId, entryId, content) => events.push({ chatId, entryId, content }));

      await orchQueue.triggerDrain('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'queued msg', expect.objectContaining({
        permissionMode: 'plan',
        thinkingMode: 'low',
        claudeThinkingMode: 'off',
        ampAgentMode: 'deep',
        model: 'persisted-model',
        clientRequestId: expect.any(String),
        clientMessageId: expect.any(String),
        turnId: expect.any(String),
      }));
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

      await orchQueue.triggerDrain('c1');
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('msg1');
    });

    it('pauses on agent error via resetAndPauseChat', async () => {
      await orchQueue.enqueueChat('c1', 'will fail');
      const failures = [];
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent error'));

      await orchQueue.triggerDrain('c1');

      const result = await orchQueue.readChatQueue('c1');
      expect(result.paused).toBe(true);
      expect(result.entries[0].status).toBe('queued');
      expect(failures).toEqual([{
        chatId: 'c1',
        error: 'agent error',
        options: expect.objectContaining({
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
          model: 'persisted-model',
        }),
      }]);
    });

    it('pauses and requeues when pending input registration fails', async () => {
      await orchQueue.enqueueChat('c1', 'will fail before dispatch');
      const dispatches = [];
      const failures = [];
      orchQueue.onDispatching((chatId, entryId, content) => dispatches.push({ chatId, entryId, content }));
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));
      mockPendingInputs.register.mockRejectedValueOnce(new Error('pending input failed'));

      await orchQueue.triggerDrain('c1');

      const result = await orchQueue.readChatQueue('c1');
      expect(result.paused).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe('queued');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(dispatches).toEqual([]);
      expect(failures).toEqual([{
        chatId: 'c1',
        error: 'pending input failed',
        options: expect.objectContaining({
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
          model: 'persisted-model',
        }),
      }]);
    });

    it('pauses and requeues when queued turn option resolution fails', async () => {
      const failingQueue = new QueueManager(
        workspaceDir,
        mockAgents,
        mockPendingInputs,
        mockChatMessages,
        () => {
          throw new Error('settings unavailable');
        },
      );
      await failingQueue.enqueueChat('c1', 'will fail before registration');
      const dispatches = [];
      const failures = [];
      failingQueue.onDispatching((chatId, entryId, content) => dispatches.push({ chatId, entryId, content }));
      failingQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      await failingQueue.triggerDrain('c1');

      const result = await failingQueue.readChatQueue('c1');
      expect(result.paused).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe('queued');
      expect(mockPendingInputs.register).not.toHaveBeenCalled();
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(dispatches).toEqual([]);
      expect(failures).toEqual([{
        chatId: 'c1',
        error: 'settings unavailable',
        options: {},
      }]);
    });

    it('registers queued messages as pending input before dispatch', async () => {
      await orchQueue.enqueueChat('c1', 'queued text');

      await orchQueue.triggerDrain('c1');

      expect(mockPendingInputs.register).toHaveBeenCalledWith('c1', 'queued text', expect.objectContaining({
        clientRequestId: expect.any(String),
        clientMessageId: expect.any(String),
        turnId: expect.any(String),
        deliveryStatus: 'accepted',
      }));
    });

    it('uses persisted chat settings instead of triggering turn overrides for drained queued turns', async () => {
      await orchQueue.enqueueChat('c1', 'queued text');

      await orchQueue.runAcceptedTurn('c1', 'active turn', {
        clientRequestId: 'req-active',
        clientMessageId: 'msg-active',
        turnId: 'turn-active',
        permissionMode: 'bypassPermissions',
        thinkingMode: 'max',
        claudeThinkingMode: 'on',
        ampAgentMode: 'smart',
        model: 'one-shot-model',
      });

      const activeTurnOptions = mockAgents.runAgentTurn.mock.calls[0]?.[2];
      const queuedTurnOptions = mockAgents.runAgentTurn.mock.calls[1]?.[2];
      expect(activeTurnOptions.permissionMode).toBe('bypassPermissions');
      expect(activeTurnOptions.model).toBe('one-shot-model');
      expect(queuedTurnOptions.permissionMode).toBe('plan');
      expect(queuedTurnOptions.thinkingMode).toBe('low');
      expect(queuedTurnOptions.claudeThinkingMode).toBe('off');
      expect(queuedTurnOptions.ampAgentMode).toBe('deep');
      expect(queuedTurnOptions.model).toBe('persisted-model');
      expect(queuedTurnOptions.clientRequestId).toEqual(expect.any(String));
      expect(queuedTurnOptions.clientMessageId).toEqual(expect.any(String));
      expect(queuedTurnOptions.turnId).toEqual(expect.any(String));
      expect(queuedTurnOptions.clientRequestId).not.toBe('req-active');
      expect(queuedTurnOptions.clientMessageId).not.toBe('msg-active');
      expect(queuedTurnOptions.turnId).not.toBe('turn-active');
    });
  });

  describe('chat-idle event', () => {
    it('fires after drain completes with empty queue', async () => {
      await orchQueue.enqueueChat('c1', 'msg');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1');
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

    it('does NOT fire when drain exits because agent is running', async () => {
      await orchQueue.enqueueChat('c1', 'msg');
      mockAgents.isChatRunning.mockReturnValue(true);

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1');
      expect(idleEvents).toHaveLength(0);
    });

    it('does NOT fire when drain exits because the queue is paused', async () => {
      await orchQueue.enqueueChat('c1', 'msg');
      await orchQueue.pauseChatQueue('c1');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(idleEvents).toHaveLength(0);
    });
  });

  describe('checkChatIdle', () => {
    it('emits chat-idle when queue is empty and agent not running', async () => {
      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');
      expect(idleEvents).toEqual(['c1']);
    });

    it('does NOT emit when agent is running', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');
      expect(idleEvents).toHaveLength(0);
    });

    it('drains a queued entry left by a turn that bypassed #drain', async () => {
      // Models the chat-start path: the first turn runs via startSession (not
      // runAcceptedTurn), a message is queued mid-turn, and the turn finishes.
      // checkChatIdle must resume draining instead of leaving the entry stuck.
      await orchQueue.enqueueChat('c1', 'pending msg');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'pending msg', expect.any(Object));
      const queue = await orchQueue.readChatQueue('c1');
      expect(queue.entries).toHaveLength(0);
      expect(idleEvents).toEqual(['c1']);
    });

    it('does NOT drain a queued entry while the queue is paused', async () => {
      await orchQueue.enqueueChat('c1', 'pending msg');
      await orchQueue.pauseChatQueue('c1');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');

      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(idleEvents).toHaveLength(0);
      const queue = await orchQueue.readChatQueue('c1');
      expect(queue.entries).toHaveLength(1);
    });
  });
});

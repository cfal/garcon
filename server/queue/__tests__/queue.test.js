import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { QueueManager } from '../../queue.js';
import { normalizeStoredQueueState } from '../../queue-state.js';
import { ACTIVE_INPUT_NOT_DELIVERED_MESSAGE, ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE } from '../../lib/domain-error.js';

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
    markFailed: mock(() => true),
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
      return Promise.resolve({
        generationId: 'generation-1',
        messages: viewMessages,
      });
    }),
  };
}

function emptyDrainOptions() {
  return {};
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function storedQueueFixture(overrides = {}) {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    version: 0,
    updatedAt: null,
    ...overrides,
  };
}

function queueEntryFixture(id, content) {
  return {
    id,
    content,
    status: 'queued',
    revision: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
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
    () => true,
  );
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('queue invariants', () => {
  it('does not create a pause on an empty queue', async () => {
    const result = await queue.pauseChatQueue('123');
    expect(result.entries).toHaveLength(0);
    expect(result.pause).toBeNull();
  });

  it('clears the pause when the last queued entry is removed', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'hello');
    await queue.pauseChatQueue('123');

    const result = await queue.deleteChatQueueEntry('123', entry.id);
    expect(result.queue.entries).toHaveLength(0);
    expect(result.queue.pause).toBeNull();
  });

  it('normalizes stale queue files where paused=true but entries are empty', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(path.join(queuesDir, '123.queue.json'), JSON.stringify({ entries: [], paused: true }), 'utf8');

    const result = await queue.readChatQueue('123');
    expect(result.entries).toEqual([]);
    expect(result.pause).toBeNull();
  });

  it('derives a stable fail-closed pause for legacy and malformed persisted state', () => {
    const entry = {
      id: 'entry-1',
      content: 'queued',
      status: 'queued',
      revision: 1,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    const legacy = {
      entries: [entry],
      paused: true,
      version: 4,
      updatedAt: '2026-07-16T00:01:00.000Z',
    };

    const first = normalizeStoredQueueState(legacy);
    const second = normalizeStoredQueueState(legacy);
    const malformed = normalizeStoredQueueState({
      ...legacy,
      paused: undefined,
      pause: { id: '', kind: 'manual', pausedAt: 'not-a-timestamp' },
    });

    expect(first.pause).toMatchObject({ kind: 'unknown', entryId: entry.id });
    expect(second.pause.id).toBe(first.pause.id);
    expect(malformed.pause).toMatchObject({ kind: 'unknown', entryId: entry.id });
    expect(malformed.pause.id).not.toBe(first.pause.id);
  });

  it('canonicalizes legacy paused queue files during startup recovery', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    const queuePath = path.join(queuesDir, 'legacy.queue.json');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        entries: [{
          id: 'legacy-entry',
          content: 'queued',
          status: 'queued',
          createdAt: '2026-07-16T00:00:00.000Z',
        }],
        paused: true,
        version: 2,
        updatedAt: '2026-07-16T00:01:00.000Z',
      }),
      'utf8',
    );

    await queue.recoverStaleChatQueues();

    const persisted = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    expect(persisted).not.toHaveProperty('paused');
    expect(persisted.pause).toMatchObject({ kind: 'unknown', entryId: 'legacy-entry' });
    expect(persisted.version).toBe(3);
  });

  it('returns defensive queue copies from reads', async () => {
    await queue.createChatQueueEntry('123', 'hello');

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
        entries: [
          {
            id: 'entry-1',
            content: 'persisted',
            status: 'queued',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        pause: null,
      }),
      'utf8',
    );

    await queue.readChatQueue('cached');
    await fs.writeFile(
      path.join(queuesDir, 'cached.queue.json'),
      JSON.stringify({ entries: [], pause: null }),
      'utf8',
    );

    const result = await queue.pauseChatQueue('cached');
    expect(result.entries.map((entry) => entry.content)).toEqual(['persisted']);
    expect(result.pause).not.toBeNull();
  });

  it('clears cached state when deleting a queue file', async () => {
    await queue.createChatQueueEntry('123', 'hello');

    await queue.deleteChatQueueFile('123');
    const result = await queue.readChatQueue('123');

    expect(result.entries).toEqual([]);
    expect(result.pause).toBeNull();
  });

  it('bumps version and updatedAt across queue mutations', async () => {
    const first = await queue.createChatQueueEntry('123', 'hello');
    const paused = await queue.pauseChatQueue('123');
    const resumed = await queue.resumeChatQueue('123', paused.pause.id);

    expect(first.queue.version).toBe(1);
    expect(typeof first.queue.updatedAt).toBe('string');
    expect(paused.version).toBe(2);
    expect(typeof paused.updatedAt).toBe('string');
    expect(resumed.version).toBe(3);
    expect(typeof resumed.updatedAt).toBe('string');
  });

  it('does not persist or publish idempotent pause and resume no-ops', async () => {
    await queue.createChatQueueEntry('123', 'hello');
    const paused = await queue.pauseChatQueue('123');
    const events = [];
    queue.onQueueUpdated((chatId, queueState) => events.push({ chatId, queueState }));

    const duplicatePause = await queue.pauseChatQueue('123');
    expect(duplicatePause.version).toBe(paused.version);
    expect(events).toHaveLength(0);

    const resumed = await queue.resumeChatQueue('123', paused.pause.id);
    expect(events).toHaveLength(1);
    events.length = 0;

    const duplicateResume = await queue.resumeChatQueue('123', paused.pause.id);
    expect(duplicateResume.version).toBe(resumed.version);
    expect(events).toHaveLength(0);
  });

  it('rejects a stale resume when an automatic pause supersedes the rendered pause', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'hello');
    const manual = await queue.pauseChatQueue('123');
    const automatic = await queue.requeueAndPauseChat('123', entry.id, 'queued-turn-failed');

    expect(automatic.pause.id).not.toBe(manual.pause.id);
    await expect(queue.resumeChatQueue('123', manual.pause.id)).rejects.toMatchObject({
      code: 'QUEUE_PAUSE_CHANGED',
      queue: expect.objectContaining({
        pause: expect.objectContaining({ id: automatic.pause.id, kind: 'queued-turn-failed' }),
      }),
    });
    expect((await queue.readChatQueue('123')).pause.id).toBe(automatic.pause.id);
  });

  it('serializes pause and pop so the queue-lock winner defines the dispatch boundary', async () => {
    const pauseFirst = await queue.createChatQueueEntry('pause-first', 'first');
    await queue.createChatQueueEntry('pause-first', 'second');

    const [paused, blockedPop] = await Promise.all([
      queue.pauseChatQueue('pause-first'),
      queue.popNextChat('pause-first'),
    ]);

    expect(paused.pause).toMatchObject({ kind: 'manual' });
    expect(blockedPop).toBeNull();
    expect(paused.entries).toEqual([
      expect.objectContaining({ id: pauseFirst.entry.id, status: 'queued' }),
      expect.objectContaining({ status: 'queued' }),
    ]);

    const popFirst = await queue.createChatQueueEntry('pop-first', 'first');
    const tail = await queue.createChatQueueEntry('pop-first', 'second');
    const [popped, tailPaused] = await Promise.all([
      queue.popNextChat('pop-first'),
      queue.pauseChatQueue('pop-first'),
    ]);

    expect(popped.entry.id).toBe(popFirst.entry.id);
    expect(tailPaused.pause).toMatchObject({ kind: 'manual' });
    expect(tailPaused.entries).toEqual([
      expect.objectContaining({ id: popFirst.entry.id, status: 'sending' }),
      expect.objectContaining({ id: tail.entry.id, status: 'queued' }),
    ]);
  });

  it('creates distinct FIFO entries for every input', async () => {
    const first = await queue.createChatQueueEntry('123', 'first');
    const second = await queue.createChatQueueEntry('123', 'second');

    expect(second.queue.entries.map((entry) => entry.content)).toEqual(['first', 'second']);
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.queue.entries.map((entry) => entry.revision)).toEqual([1, 1]);
  });

  it('replays durable queue command receipts without applying mutations twice', async () => {
    const createCommand = {
      key: 'queue-entry-create:123:req-create',
      entryId: 'stable-entry-id',
    };
    const first = await queue.createChatQueueEntry('123', '  exact content\n', createCommand);
    const createRetry = await queue.createChatQueueEntry('123', '  exact content\n', createCommand);

    expect(first.duplicate).toBe(false);
    expect(createRetry.duplicate).toBe(true);
    expect(createRetry.entryId).toBe('stable-entry-id');
    expect(createRetry.queue.entries).toHaveLength(1);
    expect(createRetry.queue.entries[0].content).toBe('  exact content\n');
    expect(createRetry.queue.version).toBe(first.queue.version);

    const replaceCommand = {
      key: 'queue-entry-replace:123:req-replace',
      entryId: 'stable-entry-id',
    };
    const replaced = await queue.replaceChatQueueEntry('123', 'stable-entry-id', 'replacement', 1, replaceCommand);
    const replaceRetry = await queue.replaceChatQueueEntry('123', 'stable-entry-id', 'replacement', 1, replaceCommand);
    expect(replaceRetry.duplicate).toBe(true);
    expect(replaceRetry.queue.version).toBe(replaced.queue.version);
    expect(replaceRetry.queue.entries[0].revision).toBe(2);

    const deleteCommand = {
      key: 'queue-entry-delete:123:req-delete',
      entryId: 'stable-entry-id',
    };
    const deleted = await queue.deleteChatQueueEntry('123', 'stable-entry-id', deleteCommand);
    const deleteRetry = await queue.deleteChatQueueEntry('123', 'stable-entry-id', deleteCommand);
    expect(deleteRetry.duplicate).toBe(true);
    expect(deleteRetry.queue.version).toBe(deleted.queue.version);
    expect(deleteRetry.queue.entries).toEqual([]);
  });

  it('replaces one entry without changing its identity or position', async () => {
    const first = await queue.createChatQueueEntry('123', 'first');
    const second = await queue.createChatQueueEntry('123', 'second');

    const result = await queue.replaceChatQueueEntry('123', first.entry.id, 'edited', 1);

    expect(result.entry).toMatchObject({
      id: first.entry.id,
      content: 'edited',
      revision: 2,
    });
    expect(result.queue.entries.map((entry) => entry.id)).toEqual([first.entry.id, second.entry.id]);
  });

  it('dispatches the complete replacement when replace wins before pop', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'original');
    await queue.replaceChatQueueEntry('123', entry.id, 'complete replacement', 1);

    const popped = await queue.popNextChat('123');

    expect(popped.entry).toMatchObject({
      id: entry.id,
      content: 'complete replacement',
      revision: 2,
      status: 'sending',
    });
  });

  it('rejects stale replacements with the current queue snapshot', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'first');
    await queue.replaceChatQueueEntry('123', entry.id, 'edited elsewhere', 1);

    await expect(queue.replaceChatQueueEntry('123', entry.id, 'stale draft', 1)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      queue: expect.objectContaining({
        entries: [expect.objectContaining({ id: entry.id, revision: 2 })],
      }),
    });
  });

  it('allows exactly one of two concurrent replacements at the same revision', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'original');

    const results = await Promise.allSettled([
      queue.replaceChatQueueEntry('123', entry.id, 'first editor', 1),
      queue.replaceChatQueueEntry('123', entry.id, 'second editor', 1),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      queue: expect.objectContaining({
        entries: [expect.objectContaining({ revision: 2 })],
      }),
    });
  });

  it('marks a popped entry as dispatched and rejects stale deletion by ID', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'first');
    const popped = await queue.popNextChat('123');

    expect(popped.queue.recentlyDispatched).toEqual([expect.objectContaining({ entryId: entry.id })]);
    await expect(queue.deleteChatQueueEntry('123', entry.id)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_ALREADY_SENT',
    });

    const sent = await queue.removeSentChat('123', entry.id);
    expect(sent.entries).toEqual([]);
    expect(sent.recentlyDispatched).toEqual([expect.objectContaining({ entryId: entry.id })]);
  });

  it('does not pop queued work while another entry remains sending', async () => {
    const first = await queue.createChatQueueEntry('123', 'first');
    const second = await queue.createChatQueueEntry('123', 'second');
    const popped = await queue.popNextChat('123');

    const blocked = await queue.popNextChat('123');
    const current = await queue.readChatQueue('123');

    expect(popped.entry.id).toBe(first.entry.id);
    expect(blocked).toBeNull();
    expect(current.version).toBe(popped.queue.version);
    expect(current.entries).toEqual([
      expect.objectContaining({ id: first.entry.id, status: 'sending' }),
      expect.objectContaining({ id: second.entry.id, status: 'queued' }),
    ]);
  });

  it('rejects replacement when pop wins the queue lock first', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'original');
    await queue.popNextChat('123');

    await expect(queue.replaceChatQueueEntry('123', entry.id, 'too late', 1)).rejects.toMatchObject({
      code: 'QUEUE_ENTRY_ALREADY_SENT',
    });
  });

  it('preserves the sending entry when clear removes the queued tail', async () => {
    const first = await queue.createChatQueueEntry('123', 'first');
    await queue.createChatQueueEntry('123', 'second');
    await queue.popNextChat('123');

    const cleared = await queue.clearChatQueue('123');

    expect(cleared.entries).toEqual([expect.objectContaining({ id: first.entry.id, status: 'sending' })]);
    expect(cleared.recentlyDispatched).toEqual([expect.objectContaining({ entryId: first.entry.id })]);
    expect(cleared.pause).toBeNull();
  });

  it('restores a failed dispatch with the same revision and removes its sent marker', async () => {
    const { entry } = await queue.createChatQueueEntry('123', 'first');
    await queue.popNextChat('123');

    const reset = await queue.requeueAndPauseChat('123', entry.id, 'queued-turn-failed');

    expect(reset.entries[0]).toMatchObject({
      id: entry.id,
      status: 'queued',
      revision: 1,
    });
    expect(reset.recentlyDispatched).toEqual([]);
    expect(reset.pause).toMatchObject({ kind: 'queued-turn-failed', entryId: entry.id });
  });

  it('recovers persisted sending entries and removes their dispatch markers', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      path.join(queuesDir, 'stale.queue.json'),
      JSON.stringify(
        storedQueueFixture({
          entries: [
            {
              id: 'entry-stale',
              content: 'retry after restart',
              status: 'sending',
              revision: 3,
              createdAt: '2026-07-16T00:00:00.000Z',
              updatedAt: '2026-07-16T00:01:00.000Z',
            },
          ],
          recentlyDispatched: [
            {
              entryId: 'entry-stale',
              dispatchedAt: '2026-07-16T00:02:00.000Z',
            },
          ],
          version: 5,
        }),
      ),
      'utf8',
    );

    await queue.recoverStaleChatQueues();
    const recovered = await queue.readChatQueue('stale');

    expect(recovered.entries[0]).toMatchObject({
      id: 'entry-stale',
      status: 'queued',
      revision: 3,
    });
    expect(recovered.recentlyDispatched).toEqual([]);
    expect(recovered.pause).toMatchObject({ kind: 'recovered-inflight', entryId: 'entry-stale' });
    expect(recovered.version).toBe(6);
  });

  it('resumes unpaused persisted queue work after restart', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      path.join(queuesDir, 'ready.queue.json'),
      JSON.stringify(
        storedQueueFixture({
          entries: [
            {
              id: 'entry-ready',
              content: 'continue after restart',
              status: 'queued',
              revision: 1,
              createdAt: '2026-07-16T00:00:00.000Z',
              updatedAt: '2026-07-16T00:00:00.000Z',
            },
          ],
          version: 1,
        }),
      ),
      'utf8',
    );
    const turnRunner = {
      runAgentTurn: mock(() => Promise.resolve()),
      abortSession: mock(() => Promise.resolve(false)),
      isChatRunning: mock(() => false),
    };
    const recoveredQueue = new QueueManager(
      workspaceDir,
      turnRunner,
      createPendingInputs(),
      createChatMessages(),
      emptyDrainOptions,
      () => true,
    );
    const becameIdle = new Promise((resolve) => {
      recoveredQueue.onChatIdle((chatId) => {
        if (chatId === 'ready') resolve();
      });
    });

    await recoveredQueue.recoverStaleChatQueues();
    await becameIdle;

    expect(turnRunner.runAgentTurn).toHaveBeenCalledWith(
      'ready',
      'continue after restart',
      expect.objectContaining({
        clientRequestId: expect.any(String),
        clientMessageId: expect.any(String),
        turnId: expect.any(String),
      }),
    );
    expect((await recoveredQueue.readChatQueue('ready')).entries).toEqual([]);
  });

  it('removes persisted queues whose owning chat was deleted', async () => {
    const queuesDir = path.join(workspaceDir, 'queues');
    const queueFile = path.join(queuesDir, 'orphan.queue.json');
    await fs.mkdir(queuesDir, { recursive: true });
    await fs.writeFile(
      queueFile,
      JSON.stringify(storedQueueFixture({
        entries: [queueEntryFixture('orphan-entry', 'orphaned')],
        version: 1,
      })),
      'utf8',
    );
    const recoveringQueue = new QueueManager(
      workspaceDir,
      createStateOnlyAgents(),
      createPendingInputs(),
      createChatMessages(),
      emptyDrainOptions,
      (chatId) => chatId !== 'orphan',
    );

    await recoveringQueue.recoverStaleChatQueues();

    await expect(fs.stat(queueFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires execution dependencies at construction', () => {
    expect(() => new QueueManager(workspaceDir)).toThrow('QueueManager requires an agent turn runner');
  });
});

describe('queue-updated event', () => {
  it('emits on create', async () => {
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.createChatQueueEntry('c1', 'hello');
    expect(events).toHaveLength(1);
    expect(events[0].chatId).toBe('c1');
    expect(events[0].state.entries).toHaveLength(1);
  });

  it('emits on delete', async () => {
    const { entry } = await queue.createChatQueueEntry('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.deleteChatQueueEntry('c1', entry.id);
    expect(events).toHaveLength(1);
    expect(events[0].state.entries).toHaveLength(0);
  });

  it('emits on clear', async () => {
    await queue.createChatQueueEntry('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.clearChatQueue('c1');
    expect(events).toHaveLength(1);
    expect(events[0].state.entries).toHaveLength(0);
  });

  it('emits on pause', async () => {
    await queue.createChatQueueEntry('c1', 'hello');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    await queue.pauseChatQueue('c1');
    expect(events).toHaveLength(1);
    expect(events[0].state.pause).not.toBeNull();
  });

  it('emits on resume', async () => {
    await queue.createChatQueueEntry('c1', 'hello');
    await queue.pauseChatQueue('c1');
    const events = [];
    queue.onQueueUpdated((chatId, state) => events.push({ chatId, state }));

    const paused = await queue.readChatQueue('c1');
    await queue.resumeChatQueue('c1', paused.pause.id);
    expect(events).toHaveLength(1);
    expect(events[0].state.pause).toBeNull();
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
      markFailed: mock(() => true),
    };
    mockChatMessages = createChatMessages();
    mockDrainOptions = mock(() => ({
      permissionMode: 'plan',
      thinkingMode: 'low',
      claudeThinkingMode: 'off',
      ampAgentMode: 'deep',
      model: 'persisted-model',
    }));
    orchQueue = new QueueManager(
      workspaceDir,
      mockAgents,
      mockPendingInputs,
      mockChatMessages,
      mockDrainOptions,
      () => true,
    );
  });

  describe('submit', () => {
    it('rejects a second direct reservation before either turn prepares transcript state', async () => {
      const first = orchQueue.reserveDirectTurn('c1');

      expect(() => orchQueue.reserveDirectTurn('c1')).toThrow(
        'Another chat turn already owns execution',
      );
      expect(mockPendingInputs.register).not.toHaveBeenCalled();

      await orchQueue.releaseDirectTurn(first);
      const second = orchQueue.reserveDirectTurn('c1');
      await orchQueue.releaseDirectTurn(second);
    });

    it('cancels a direct reservation when its chat queue is deleted', async () => {
      let chatExists = true;
      const turnStarted = deferred();
      const finishTurn = deferred();
      const deletingQueue = new QueueManager(
        workspaceDir,
        {
          runAgentTurn: mock(async () => {
            turnStarted.resolve();
            await finishTurn.promise;
          }),
          abortSession: mock(async () => true),
          isChatRunning: mock(() => false),
        },
        createPendingInputs(),
        createChatMessages(),
        emptyDrainOptions,
        () => chatExists,
      );
      const reservation = deletingQueue.reserveDirectTurn('deleted');
      const turn = deletingQueue.runReservedTurn(reservation, 'running', {});
      await turnStarted.promise;

      chatExists = false;
      await deletingQueue.deleteChatQueueFile('deleted');
      finishTurn.resolve();

      await expect(turn).resolves.toBeUndefined();
      expect(deletingQueue.isChatExecutionReserved('deleted')).toBe(false);
    });

    it('reserves execution until a direct turn hands off to queued work', async () => {
      const directStarted = deferred();
      const finishDirect = deferred();
      mockAgents.runAgentTurn.mockImplementation(async (_chatId, command) => {
        if (command === 'direct') {
          directStarted.resolve();
          await finishDirect.promise;
        }
      });

      const reservation = orchQueue.reserveDirectTurn('c1');
      const directTurn = orchQueue.runReservedTurn(reservation, 'direct', {});
      await directStarted.promise;
      expect(orchQueue.isChatExecutionReserved('c1')).toBe(true);

      await orchQueue.createChatQueueEntry('c1', 'queued');
      await orchQueue.triggerDrain('c1');
      expect(mockAgents.runAgentTurn).toHaveBeenCalledTimes(1);

      finishDirect.resolve();
      await directTurn;

      expect(mockAgents.runAgentTurn).toHaveBeenNthCalledWith(2, 'c1', 'queued', expect.any(Object));
      expect(orchQueue.isChatExecutionReserved('c1')).toBe(false);
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
    });

    it('honors an interrupt drain request after an aborted direct turn releases execution', async () => {
      const directStarted = deferred();
      const finishDirect = deferred();
      mockAgents.runAgentTurn.mockImplementation(async (_chatId, command) => {
        if (command === 'direct') {
          directStarted.resolve();
          await finishDirect.promise;
        }
      });
      mockAgents.abortSession.mockImplementation(async () => {
        finishDirect.reject(new Error('aborted'));
        return true;
      });

      const reservation = orchQueue.reserveDirectTurn('c1');
      const directTurn = orchQueue.runReservedTurn(reservation, 'direct', {});
      await directStarted.promise;
      await orchQueue.createChatQueueEntry('c1', 'queued');
      const idle = new Promise((resolve) => orchQueue.onChatIdle(resolve));

      expect(await orchQueue.interruptActiveTurn('c1')).toBe(true);
      await expect(directTurn).rejects.toThrow('aborted');
      await idle;

      expect(mockAgents.runAgentTurn).toHaveBeenNthCalledWith(2, 'c1', 'queued', expect.any(Object));
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
    });

    it('runs agent turn with the given command', async () => {
      await orchQueue.submit('c1', 'hello', { permissionMode: 'default' });
      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith(
        'c1',
        'hello',
        expect.objectContaining({
          permissionMode: 'default',
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
        }),
      );
    });

    it('registers pending input for submitted turns', async () => {
      await orchQueue.submit('c1', 'hello', {});
      expect(mockPendingInputs.register).toHaveBeenCalledWith(
        'c1',
        'hello',
        expect.objectContaining({
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
          deliveryStatus: 'accepted',
        }),
      );
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

      expect(mockChatMessages.appendMessages).toHaveBeenCalledWith('c1', [
        expect.objectContaining({
          content: 'hello',
          metadata: expect.objectContaining({
            clientRequestId: 'req-1',
            turnId: 'turn-1',
            deliveryStatus: 'accepted',
          }),
        }),
      ]);
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
      await orchQueue.createChatQueueEntry('c1', 'queued msg');

      await orchQueue.submit('c1', 'initial', {});

      // Initial turn + drain turn
      expect(mockAgents.runAgentTurn).toHaveBeenCalledTimes(2);
      expect(mockAgents.runAgentTurn.mock.calls[1][1]).toBe('queued msg');
    });

    it('reports queue activity while a queued turn is being prepared', async () => {
      let releaseRegistration;
      const registrationStarted = new Promise((resolve) => {
        mockPendingInputs.register.mockImplementation(() => {
          resolve();
          return new Promise((release) => {
            releaseRegistration = release;
          });
        });
      });
      await orchQueue.createChatQueueEntry('c1', 'queued msg');

      const drain = orchQueue.triggerDrain('c1');
      await registrationStarted;

      expect(orchQueue.isChatDraining('c1')).toBe(true);
      releaseRegistration();
      await drain;
      expect(orchQueue.isChatDraining('c1')).toBe(false);
    });

    it('propagates agent errors to caller', async () => {
      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent fail'));

      await expect(orchQueue.submit('c1', 'hello', {})).rejects.toThrow('agent fail');
    });

    it('emits turn-failed with command identity when agent execution fails', async () => {
      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent fail'));
      const failures = [];
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      await expect(
        orchQueue.runReservedTurn(orchQueue.reserveDirectTurn('c1'), 'hello', {
          clientRequestId: 'req-1',
          clientMessageId: 'msg-1',
          turnId: 'turn-1',
        }),
      ).rejects.toThrow('agent fail');

      expect(failures).toEqual([
        {
          chatId: 'c1',
          error: 'agent fail',
          options: {
            clientRequestId: 'req-1',
            clientMessageId: 'msg-1',
            turnId: 'turn-1',
          },
        },
      ]);
    });

    it('does not emit a delivery revision after accepted turns complete', async () => {
      await orchQueue.runReservedTurn(orchQueue.reserveDirectTurn('c1'), 'hello', {
        clientRequestId: 'req-1',
        clientMessageId: 'msg-1',
        turnId: 'turn-1',
      });

      expect(mockChatMessages.appendMessages).not.toHaveBeenCalled();
    });
  });

  describe('active input delivery', () => {
    it('persists input by default without offering it to a running agent', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(() => Promise.resolve(true));

      const result = await orchQueue.createChatQueueEntry('c1', 'scheduled input');

      expect(mockAgents.submitActiveInput).not.toHaveBeenCalled();
      expect(result.queue.entries.map((entry) => entry.content)).toEqual(['scheduled input']);
    });

    it('registers the user row before delivering active input to a running agent', async () => {
      const order = [];
      mockAgents.isChatRunning.mockReturnValue(true);
      mockPendingInputs.register.mockImplementation(async () => {
        order.push('registered');
      });
      mockAgents.submitActiveInput = mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        order.push('delivered');
        return true;
      });

      const result = await orchQueue.deliverActiveInput('c1', '/goal pause', {
        clientRequestId: 'request-active',
        clientMessageId: 'message-active',
      });

      expect(order).toEqual(['registered', 'delivered']);
      expect(result).toBe(true);
      expect(await orchQueue.readChatQueue('c1')).toEqual(expect.objectContaining({ entries: [] }));
      expect(mockAgents.submitActiveInput).toHaveBeenCalledWith(
        'c1',
        '/goal pause',
        expect.objectContaining({
          clientRequestId: 'request-active',
          clientMessageId: 'message-active',
        }),
        expect.any(Function),
      );
    });

    it('preserves the active-input runner receiver', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(async function (_chatId, _content, _options, beforeDelivery) {
        expect(this).toBe(mockAgents);
        await beforeDelivery();
        return true;
      });

      await expect(orchQueue.deliverActiveInput('c1', 'receiver-safe')).resolves.toBe(true);
    });

    it('persists input for running agents without active-input support', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);

      const result = await orchQueue.createChatQueueEntry('c1', 'wait for later');

      expect(result.queue.entries).toHaveLength(1);
      expect(result.queue.entries[0].content).toBe('wait for later');
      expect(mockPendingInputs.register).not.toHaveBeenCalled();
    });

    it('reports unavailable active delivery without creating a queue entry', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(async () => false);

      const result = await orchQueue.deliverActiveInput('c1', 'race-safe input');

      expect(result).toBe(false);
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
      expect(mockPendingInputs.register).not.toHaveBeenCalled();
      expect(mockPendingInputs.markFailed).not.toHaveBeenCalled();
    });

    it('does not deliver active input ahead of an older queued entry', async () => {
      await orchQueue.createChatQueueEntry('c1', 'older queued input');
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(async () => true);

      const delivered = await orchQueue.deliverActiveInput('c1', 'newer input');
      const result = await orchQueue.createChatQueueEntry('c1', 'newer input');

      expect(delivered).toBe(false);
      expect(mockAgents.submitActiveInput).not.toHaveBeenCalled();
      expect(result.queue.entries.map((entry) => entry.content)).toEqual(['older queued input', 'newer input']);
      expect(new Set(result.queue.entries.map((entry) => entry.id)).size).toBe(2);
    });

    it('does not deliver active input ahead of a sending entry', async () => {
      const older = await orchQueue.createChatQueueEntry('c1', 'older sending input');
      await orchQueue.popNextChat('c1');
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(async () => true);

      const delivered = await orchQueue.deliverActiveInput('c1', 'newer input');
      const result = await orchQueue.createChatQueueEntry('c1', 'newer input');

      expect(delivered).toBe(false);
      expect(mockAgents.submitActiveInput).not.toHaveBeenCalled();
      expect(result.queue.entries).toEqual([
        expect.objectContaining({
          id: older.entry.id,
          status: 'sending',
          content: 'older sending input',
        }),
        expect.objectContaining({ status: 'queued', content: 'newer input' }),
      ]);
    });

    it('serializes concurrent creates into distinct FIFO entries', async () => {
      await Promise.all([
        orchQueue.createChatQueueEntry('c1', 'older input'),
        orchQueue.createChatQueueEntry('c1', 'newer input'),
      ]);

      const entries = (await orchQueue.readChatQueue('c1')).entries;
      expect(entries.map((entry) => entry.content)).toEqual(['older input', 'newer input']);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    });

    it('marks accepted input failed when live delivery throws', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      mockAgents.submitActiveInput = mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        throw new Error('steer failed');
      });

      await expect(
        orchQueue.deliverActiveInput('c1', 'accepted then failed', {
          clientRequestId: 'request-failed',
        }),
      ).rejects.toMatchObject({
        message: ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE,
        cause: expect.objectContaining({ message: 'steer failed' }),
        deliveryAccepted: true,
        retryable: false,
      });

      expect(mockPendingInputs.register).toHaveBeenCalledTimes(1);
      expect(mockPendingInputs.markFailed).toHaveBeenCalledWith('c1', 'request-failed');
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
    });

    it('rolls back pending registration when transcript append fails before active delivery', async () => {
      let delivered = false;
      mockAgents.isChatRunning.mockReturnValue(true);
      mockPendingInputs.register.mockResolvedValue({
        clientRequestId: 'request-append-failed',
      });
      mockChatMessages.appendMessages.mockRejectedValue(new Error('chat append failed'));
      mockAgents.submitActiveInput = mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        delivered = true;
        return true;
      });

      await expect(
        orchQueue.deliverActiveInput('c1', 'must not deliver', {
          clientRequestId: 'request-append-failed',
        }),
      ).rejects.toMatchObject({
        message: ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
        cause: expect.objectContaining({ message: 'chat append failed' }),
        deliveryAccepted: false,
        retryable: true,
      });

      expect(delivered).toBe(false);
      expect(mockPendingInputs.discard).toHaveBeenCalledWith('c1', 'request-append-failed');
      expect(mockPendingInputs.markFailed).not.toHaveBeenCalled();
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
    });

    it('continues active delivery once after a post-commit chat listener fails', async () => {
      let deliveries = 0;
      mockAgents.isChatRunning.mockReturnValue(true);
      mockPendingInputs.register.mockResolvedValue({
        clientRequestId: 'request-listener-failed',
      });
      mockAgents.submitActiveInput = mock(async (_chatId, _content, _options, beforeDelivery) => {
        await beforeDelivery();
        deliveries += 1;
        return true;
      });
      orchQueue.onChatMessages(() => {
        throw new Error('listener failed');
      });

      const result = await orchQueue.deliverActiveInput('c1', 'deliver despite listener', {
        clientRequestId: 'request-listener-failed',
      });

      expect(result).toBe(true);
      expect(deliveries).toBe(1);
      expect(mockChatMessages.appendMessages).toHaveBeenCalledTimes(1);
      expect(mockPendingInputs.discard).not.toHaveBeenCalled();
      expect(mockPendingInputs.markFailed).not.toHaveBeenCalled();
      expect((await orchQueue.readChatQueue('c1')).entries).toEqual([]);
    });
  });

  describe('turn interruption', () => {
    it('calls turn runner abortSession', async () => {
      await orchQueue.interruptActiveTurn('c1');
      expect(mockAgents.abortSession).toHaveBeenCalledWith('c1');
    });

    it('emits session-stop-requested before abortSession', async () => {
      const events = [];
      mockAgents.abortSession.mockImplementation((chatId) => {
        events.push(`abort:${chatId}`);
        return Promise.resolve(true);
      });
      orchQueue.onSessionStopRequested((chatId) => events.push(`requested:${chatId}`));

      await orchQueue.interruptActiveTurn('c1');

      expect(events).toEqual(['requested:c1', 'abort:c1']);
    });

    it('emits session-stopped event', async () => {
      const events = [];
      orchQueue.onSessionStopped((chatId, success) => events.push({ chatId, success }));

      await orchQueue.interruptActiveTurn('c1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ chatId: 'c1', success: true });
    });

    it('coalesces concurrent stop requests into one runtime abort lifecycle', async () => {
      const abortResult = deferred();
      const requested = [];
      const stopped = [];
      mockAgents.abortSession.mockImplementation(() => abortResult.promise);
      orchQueue.onSessionStopRequested((chatId) => requested.push(chatId));
      orchQueue.onSessionStopped((chatId, success) => stopped.push({ chatId, success }));

      const first = orchQueue.interruptActiveTurn('c1');
      const second = orchQueue.interruptActiveTurn('c1');
      abortResult.resolve(true);

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(mockAgents.abortSession).toHaveBeenCalledTimes(1);
      expect(requested).toEqual(['c1']);
      expect(stopped).toEqual([{ chatId: 'c1', success: true }]);
    });

    it('drains queued entries after abort succeeds', async () => {
      await orchQueue.createChatQueueEntry('c1', 'pending');
      const dispatched = new Promise((resolve) => {
        orchQueue.onDispatching((chatId, entryId, content) => resolve({ chatId, entryId, content }));
      });
      const idle = new Promise((resolve) => {
        orchQueue.onChatIdle((chatId) => resolve(chatId));
      });

      await orchQueue.interruptActiveTurn('c1');
      const event = await dispatched;
      await idle;

      expect(event).toMatchObject({ chatId: 'c1', content: 'pending' });
      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'pending', expect.any(Object));
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(0);
      expect(result.pause).toBeNull();
    });

    it('allows the queued entry to drain when abort races checkChatIdle', async () => {
      await orchQueue.createChatQueueEntry('c1', 'queued during turn');
      const idle = new Promise((resolve) => orchQueue.onChatIdle(resolve));
      mockAgents.abortSession.mockImplementation(async () => {
        await orchQueue.checkChatIdle('c1');
        return true;
      });

      await orchQueue.interruptActiveTurn('c1');
      await idle;

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'queued during turn', expect.any(Object));
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(0);
      expect(result.pause).toBeNull();
    });

    it('leaves queued entries untouched when abort fails', async () => {
      await orchQueue.createChatQueueEntry('c1', 'pending');
      mockAgents.abortSession.mockResolvedValue(false);

      await orchQueue.interruptActiveTurn('c1');

      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(1);
      expect(result.pause).toBeNull();
    });

    it('pauses queued entries when Stop succeeds', async () => {
      await orchQueue.createChatQueueEntry('c1', 'pending');

      const stopped = await orchQueue.stopActiveTurn('c1');

      expect(mockAgents.abortSession).toHaveBeenCalledWith('c1');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(1);
      expect(result.pause).toMatchObject({ kind: 'manual' });
      expect(stopped.queue).toEqual(result);

      await orchQueue.resumeChatQueue('c1', result.pause.id);
      await orchQueue.triggerDrain('c1');
      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'pending', expect.any(Object));
    });

    it('does not drain Stop when checkChatIdle races abortSession', async () => {
      await orchQueue.createChatQueueEntry('c1', 'queued during stop');
      mockAgents.abortSession.mockImplementation(async () => {
        await orchQueue.checkChatIdle('c1');
        return true;
      });

      await orchQueue.stopActiveTurn('c1');

      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(1);
      expect(result.pause).toMatchObject({ kind: 'manual' });
    });

    it('treats a draining turn rejection caused by Stop as an expected abort', async () => {
      const turnStarted = deferred();
      const turnResult = deferred();
      const failures = [];
      mockAgents.runAgentTurn.mockImplementation(async () => {
        turnStarted.resolve();
        await turnResult.promise;
      });
      mockAgents.abortSession.mockImplementation(async () => {
        turnResult.reject(new Error('runtime rejects aborted turns'));
        return true;
      });
      orchQueue.onTurnFailed((_chatId, message) => failures.push(message));
      await orchQueue.createChatQueueEntry('c1', 'currently dispatching');
      const drain = orchQueue.triggerDrain('c1');
      await turnStarted.promise;

      const stopped = await orchQueue.stopActiveTurn('c1');
      await drain;

      expect(stopped.stopped).toBe(true);
      expect(failures).toEqual([]);
      expect(mockPendingInputs.markFailed).not.toHaveBeenCalled();
      expect((await orchQueue.readChatQueue('c1'))).toMatchObject({
        entries: [],
        pause: null,
      });
    });

    it('does not dispatch the successor before the interrupted stop is acknowledged', async () => {
      const firstTurnStarted = deferred();
      const firstTurnResult = deferred();
      const abortAcknowledged = deferred();
      let successorStarted = false;
      mockAgents.runAgentTurn.mockImplementation(async (_chatId, command) => {
        if (command === 'interrupted') {
          firstTurnStarted.resolve();
          await firstTurnResult.promise;
          return;
        }
        successorStarted = true;
      });
      mockAgents.abortSession.mockImplementation(async () => {
        firstTurnResult.reject(new Error('runtime rejects aborted turns'));
        await abortAcknowledged.promise;
        return true;
      });
      await orchQueue.createChatQueueEntry('c1', 'interrupted');
      await orchQueue.createChatQueueEntry('c1', 'successor');
      const drain = orchQueue.triggerDrain('c1');
      await firstTurnStarted.promise;

      const interrupt = orchQueue.interruptActiveTurn('c1');
      await Promise.resolve();
      expect(successorStarted).toBe(false);

      abortAcknowledged.resolve();
      await interrupt;
      await drain;
      expect(successorStarted).toBe(true);
    });

    it('does not apply a resolved interrupt to the next queued turn failure', async () => {
      const firstTurnStarted = deferred();
      const firstTurnResult = deferred();
      const failures = [];
      mockAgents.runAgentTurn.mockImplementation(async (_chatId, command) => {
        if (command === 'interrupted') {
          firstTurnStarted.resolve();
          await firstTurnResult.promise;
          return;
        }
        throw new Error('next turn genuinely failed');
      });
      mockAgents.abortSession.mockImplementation(async () => {
        firstTurnResult.resolve();
        return true;
      });
      orchQueue.onTurnFailed((_chatId, message) => failures.push(message));
      await orchQueue.createChatQueueEntry('c1', 'interrupted');
      await orchQueue.createChatQueueEntry('c1', 'must remain queued');

      const drain = orchQueue.triggerDrain('c1');
      await firstTurnStarted.promise;
      expect(await orchQueue.interruptActiveTurn('c1')).toBe(true);
      await drain;

      const queue = await orchQueue.readChatQueue('c1');
      expect(failures).toEqual(['next turn genuinely failed']);
      expect(queue.entries).toMatchObject([{
        content: 'must remain queued',
        status: 'queued',
      }]);
      expect(queue.pause).toMatchObject({
        kind: 'queued-turn-failed',
        entryId: queue.entries[0].id,
      });
    });

    it('clears deletion suppression when a queue file is deleted', async () => {
      await orchQueue.createChatQueueEntry('c1', 'old pending');
      await orchQueue.abortForChatDeletion('c1');
      await orchQueue.deleteChatQueueFile('c1');

      await orchQueue.createChatQueueEntry('c1', 'new pending');
      await orchQueue.checkChatIdle('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'new pending', expect.any(Object));
      const result = await orchQueue.readChatQueue('c1');
      expect(result.entries).toHaveLength(0);
    });
  });

  describe('triggerDrain', () => {
    it('does not recreate a queue file when its chat is deleted mid-drain', async () => {
      let chatExists = true;
      const turnStarted = deferred();
      const finishTurn = deferred();
      const turnRunner = {
        runAgentTurn: mock(async () => {
          turnStarted.resolve();
          await finishTurn.promise;
        }),
        abortSession: mock(() => Promise.resolve(true)),
        isChatRunning: mock(() => false),
      };
      const deletingQueue = new QueueManager(
        workspaceDir,
        turnRunner,
        createPendingInputs(),
        createChatMessages(),
        emptyDrainOptions,
        () => chatExists,
      );
      const queueFile = path.join(workspaceDir, 'queues', 'deleted.queue.json');
      await deletingQueue.createChatQueueEntry('deleted', 'queued');

      const drain = deletingQueue.triggerDrain('deleted');
      await turnStarted.promise;
      chatExists = false;
      await deletingQueue.deleteChatQueueFile('deleted');
      finishTurn.reject(new Error('aborted for deletion'));
      await drain;

      await expect(fs.stat(queueFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is a no-op when agent is running', async () => {
      mockAgents.isChatRunning.mockReturnValue(true);
      await orchQueue.createChatQueueEntry('c1', 'queued');

      await orchQueue.triggerDrain('c1');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
    });

    it('drains queued entries when agent is idle', async () => {
      await orchQueue.createChatQueueEntry('c1', 'queued msg');

      const events = [];
      orchQueue.onDispatching((chatId, entryId, content) => events.push({ chatId, entryId, content }));

      await orchQueue.triggerDrain('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith(
        'c1',
        'queued msg',
        expect.objectContaining({
          permissionMode: 'plan',
          thinkingMode: 'low',
          claudeThinkingMode: 'off',
          ampAgentMode: 'deep',
          model: 'persisted-model',
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('queued msg');
    });
  });

  describe('drain', () => {
    it('emits dispatching for each entry', async () => {
      await orchQueue.createChatQueueEntry('c1', 'msg1');
      // Second enqueue appends to existing entry since status is 'queued'.
      // Use separate chats or pop the first to test sequential drain.
      const events = [];
      orchQueue.onDispatching((chatId, entryId, content) => events.push({ chatId, content }));

      await orchQueue.triggerDrain('c1');
      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('msg1');
    });

    it('pauses on agent error with a queued-turn-failed reason', async () => {
      await orchQueue.createChatQueueEntry('c1', 'will fail');
      const failures = [];
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      mockAgents.runAgentTurn.mockRejectedValue(new Error('agent error'));

      await orchQueue.triggerDrain('c1');

      const result = await orchQueue.readChatQueue('c1');
      expect(result.pause).toMatchObject({
		kind: 'queued-turn-failed',
		entryId: result.entries[0].id,
	  });
      expect(result.entries[0].status).toBe('queued');
      expect(failures).toEqual([
        {
          chatId: 'c1',
          error: 'agent error',
          options: expect.objectContaining({
            clientRequestId: expect.any(String),
            clientMessageId: expect.any(String),
            turnId: expect.any(String),
            model: 'persisted-model',
          }),
        },
      ]);
    });

    it('pauses and requeues when pending input registration fails', async () => {
      await orchQueue.createChatQueueEntry('c1', 'will fail before dispatch');
      const dispatches = [];
      const failures = [];
      orchQueue.onDispatching((chatId, entryId, content) => dispatches.push({ chatId, entryId, content }));
      orchQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));
      mockPendingInputs.register.mockRejectedValueOnce(new Error('pending input failed'));

      await orchQueue.triggerDrain('c1');

      const result = await orchQueue.readChatQueue('c1');
      expect(result.pause).toMatchObject({
		kind: 'queued-turn-failed',
		entryId: result.entries[0].id,
	  });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe('queued');
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(dispatches).toEqual([]);
      expect(failures).toEqual([
        {
          chatId: 'c1',
          error: 'pending input failed',
          options: expect.objectContaining({
            clientRequestId: expect.any(String),
            clientMessageId: expect.any(String),
            turnId: expect.any(String),
            model: 'persisted-model',
          }),
        },
      ]);
    });

    it('pauses and requeues when queued turn option resolution fails', async () => {
      const failingQueue = new QueueManager(workspaceDir, mockAgents, mockPendingInputs, mockChatMessages, () => {
        throw new Error('settings unavailable');
      }, () => true);
      await failingQueue.createChatQueueEntry('c1', 'will fail before registration');
      const dispatches = [];
      const failures = [];
      failingQueue.onDispatching((chatId, entryId, content) => dispatches.push({ chatId, entryId, content }));
      failingQueue.onTurnFailed((chatId, error, options) => failures.push({ chatId, error, options }));

      await failingQueue.triggerDrain('c1');

      const result = await failingQueue.readChatQueue('c1');
      expect(result.pause).toMatchObject({
		kind: 'queued-turn-failed',
		entryId: result.entries[0].id,
	  });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe('queued');
      expect(mockPendingInputs.register).not.toHaveBeenCalled();
      expect(mockAgents.runAgentTurn).not.toHaveBeenCalled();
      expect(dispatches).toEqual([]);
      expect(failures).toEqual([
        {
          chatId: 'c1',
          error: 'settings unavailable',
          options: {},
        },
      ]);
    });

    it('records completion-uncertain without requeueing an entry whose removal committed', async () => {
      const first = await orchQueue.createChatQueueEntry('c1', 'first');
      const second = await orchQueue.createChatQueueEntry('c1', 'second');
      const failures = [];
      let updateCount = 0;
      orchQueue.onTurnFailed((chatId, error) => failures.push({ chatId, error }));
      orchQueue.onQueueUpdated(() => {
        updateCount += 1;
        if (updateCount === 2) throw new Error('publish after finalization failed');
      });

      await orchQueue.triggerDrain('c1');

      const result = await orchQueue.readChatQueue('c1');
      expect(mockAgents.runAgentTurn).toHaveBeenCalledTimes(1);
      expect(result.entries).toEqual([
        expect.objectContaining({ id: second.entry.id, status: 'queued' }),
      ]);
      expect(result.pause).toMatchObject({
        kind: 'completion-uncertain',
        entryId: first.entry.id,
      });
      expect(result.recentlyDispatched).toContainEqual(
        expect.objectContaining({ entryId: first.entry.id }),
      );
      expect(failures).toEqual([]);
    });

    it('registers queued messages as pending input before dispatch', async () => {
      await orchQueue.createChatQueueEntry('c1', 'queued text');

      await orchQueue.triggerDrain('c1');

      expect(mockPendingInputs.register).toHaveBeenCalledWith(
        'c1',
        'queued text',
        expect.objectContaining({
          clientRequestId: expect.any(String),
          clientMessageId: expect.any(String),
          turnId: expect.any(String),
          deliveryStatus: 'accepted',
        }),
      );
    });

    it('uses persisted chat settings instead of triggering turn overrides for drained queued turns', async () => {
      await orchQueue.createChatQueueEntry('c1', 'queued text');

      await orchQueue.runReservedTurn(orchQueue.reserveDirectTurn('c1'), 'active turn', {
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
      await orchQueue.createChatQueueEntry('c1', 'msg');

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
      await orchQueue.createChatQueueEntry('c1', 'msg');
      mockAgents.isChatRunning.mockReturnValue(true);

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.triggerDrain('c1');
      expect(idleEvents).toHaveLength(0);
    });

    it('does NOT fire when drain exits because the queue is paused', async () => {
      await orchQueue.createChatQueueEntry('c1', 'msg');
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
      // runReservedTurn), a message is queued mid-turn, and the turn finishes.
      // checkChatIdle must resume draining instead of leaving the entry stuck.
      await orchQueue.createChatQueueEntry('c1', 'pending msg');

      const idleEvents = [];
      orchQueue.onChatIdle((chatId) => idleEvents.push(chatId));

      await orchQueue.checkChatIdle('c1');

      expect(mockAgents.runAgentTurn).toHaveBeenCalledWith('c1', 'pending msg', expect.any(Object));
      const queue = await orchQueue.readChatQueue('c1');
      expect(queue.entries).toHaveLength(0);
      expect(idleEvents).toEqual(['c1']);
    });

    it('does NOT drain a queued entry while the queue is paused', async () => {
      await orchQueue.createChatQueueEntry('c1', 'pending msg');
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

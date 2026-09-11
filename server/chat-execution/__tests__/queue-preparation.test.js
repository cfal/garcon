import { expect, mock, test } from 'bun:test';
import { ChatExecutionControlOperations } from '../chat-execution-control-operations.js';
import { InMemoryChatExecutionControlRepository } from '../chat-execution-control-repository.js';
import { ExecutionOwnership } from '../execution-ownership.js';
import { QueueDrainer } from '../queue-drainer.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { DomainError } from '../../lib/domain-error.js';

async function fixture() {
  const ownership = new ExecutionOwnership();
  ownership.beginDrain('chat-1');
  const repository = new InMemoryChatExecutionControlRepository('synthetic-server');
  const queueLock = new KeyedPromiseLock();
  const selectionLock = new KeyedPromiseLock();
  const projectAdmission = { assertAvailable: async () => {} };
  const controls = new ChatExecutionControlOperations(repository, {
    runExclusive: (chatId, run) => queueLock.runExclusive(chatId, run),
    chatExists: () => true, unsettledQueueReceiptKeys: () => new Set(), publish() {},
  }, projectAdmission);
  const created = await controls.create('chat-1', 'synthetic original');
  const ready = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const tickets = [];
  const order = [];
  const runner = {
    isChatRunning: () => false,
    prepareTurn: mock(async (_chatId, options) => {
      const ticket = { validate: mock(() => {}), release: mock(() => {}), options };
      tickets.push(ticket);
      order.push('prepare');
      if (tickets.length === 1) { entered.resolve(); await ready.promise; }
      return ticket;
    }),
    runAgentTurn: mock(async (chatId, _content, options) => {
      expect(options.preparedExecution).toBe(tickets.at(-1));
      expect(options.turnId).toBe(tickets.at(-1).options.turnId);
      expect(repository.load(chatId).entries).toEqual([]);
      order.push('dispatch');
      ownership.retireAttempt(chatId, ownership.attempt(chatId));
    }),
  };
  const callbacks = {
    isShuttingDown: () => false,
    registerQueued: mock((_chatId, _content, options) => {
      order.push('commit');
      options.validateBeforeCommit();
      return true;
    }),
    appendControlReceipt: mock(() => {}), isControlInputViewCurrent: () => true,
    discardPreparedInput: mock(() => {}), publishIdle() {}, publishProjectUnavailable() {},
    publishTurnFailed: mock(() => {}), retireAttempt: (chatId, attempt) => ownership.retireAttempt(chatId, attempt),
  };
  const drainer = new QueueDrainer({ ownership, controls, callbacks, turnRunner: runner,
    projectAdmission,
    runSelectionAdmissionExclusive: (chatId, operation) => selectionLock.runExclusive(chatId, operation),
  });
  return { ownership, repository, controls, created, ready, entered, tickets, order, runner, callbacks, drainer, selectionLock };
}

test('prepares outside both locks and re-prepares an edited queue head without committing the old input', async () => {
  const f = await fixture();
  const running = f.drainer.run('chat-1');
  await f.entered.promise;
  await f.selectionLock.runExclusive('chat-1', async () => {
    expect(f.order).toEqual(['prepare']);
  });
  await f.controls.replace('chat-1', f.created.entryId, 'synthetic edited', 1);
  f.ready.resolve();
  await running;
  expect(f.tickets).toHaveLength(2);
  expect(f.tickets[0].release).toHaveBeenCalledOnce();
  expect(f.tickets[1].release).toHaveBeenCalledOnce();
  expect(f.tickets[0].options.turnId).not.toBe(f.tickets[1].options.turnId);
  expect(f.callbacks.registerQueued).toHaveBeenCalledOnce();
  expect(f.callbacks.registerQueued.mock.calls[0][1]).toBe('synthetic edited');
  expect(f.runner.runAgentTurn).toHaveBeenCalledOnce();
  expect(f.order).toEqual(['prepare', 'prepare', 'commit', 'dispatch']);
});

test.each(['move', 'control'])('re-prepares the current head after %s overtakes a pending preparation', async (interleaving) => {
  const f = await fixture();
  const dispatched = [];
  f.runner.runAgentTurn.mockImplementation(async (chatId, content, options) => {
    expect(options.preparedExecution).toBe(f.tickets.at(-1));
    expect(options.turnId).toBe(f.tickets.at(-1).options.turnId);
    dispatched.push(content);
    f.ownership.retireAttempt(chatId, f.ownership.attempt(chatId));
  });
  const running = f.drainer.run('chat-1');
  await f.entered.promise;
  if (interleaving === 'move') {
    const added = await f.controls.create('chat-1', 'synthetic priority');
    const control = await f.controls.read('chat-1');
    await f.controls.move('chat-1', {
      entryId: added.entryId, targetEntryId: f.created.entryId, placement: 'before',
      expectedReorderRevision: control.reorderRevision,
      expectedSourceRevision: 1, expectedTargetRevision: 1,
    });
  } else {
    await f.controls.enqueueControl('chat-1', {
      content: 'synthetic priority', transcriptViewId: 'synthetic-view',
      createdAt: '2026-01-01T00:00:00.000Z', receipt: null,
    });
  }
  f.ready.resolve();
  await running;
  expect(dispatched).toEqual(['synthetic priority', 'synthetic original']);
  expect(f.tickets).toHaveLength(3);
  expect(f.tickets[0].validate).not.toHaveBeenCalled();
  for (const ticket of f.tickets) expect(ticket.release).toHaveBeenCalledOnce();
  for (const call of f.callbacks.registerQueued.mock.calls) {
    expect(call[2].turnId).not.toBe(f.tickets[0].options.turnId);
  }
});

test.each(['delete', 'duplicate', 'preamble', 'stop'])('releases unused preparation after %s without dispatch', async (interleaving) => {
  const f = await fixture();
  if (interleaving === 'duplicate') f.callbacks.registerQueued.mockImplementation(() => false);
  if (interleaving === 'preamble') f.callbacks.registerQueued.mockImplementation(() => {
    throw new DomainError('PREAMBLE_SLASH_COMMAND_BLOCKED', 'synthetic preamble rejection', 422);
  });
  const running = f.drainer.run('chat-1');
  await f.entered.promise;
  if (interleaving === 'delete') await f.controls.delete('chat-1', f.created.entryId);
  if (interleaving === 'stop') {
    f.ownership.enterManualStop('chat-1');
    f.ownership.abortAdmission('chat-1', new Error('synthetic Stop'));
    expect(f.runner.prepareTurn.mock.calls[0][2].aborted).toBe(true);
  }
  f.ready.resolve();
  await running;
  expect(f.tickets[0].release).toHaveBeenCalledOnce();
  expect(f.runner.runAgentTurn).not.toHaveBeenCalled();
  if (interleaving === 'stop') expect((await f.controls.read('chat-1')).entries).toHaveLength(1);
  else expect((await f.controls.read('chat-1')).entries).toEqual([]);
});

test.each(['prepare', 'commit'])('preserves queued input and reports an actionable failure when %s validation fails', async (phase) => {
  const f = await fixture();
  const failure = new DomainError('SESSION_BUSY', 'synthetic changed binding', 409, true);
  if (phase === 'prepare') f.runner.prepareTurn.mockImplementation(async () => { throw failure; });
  const running = f.drainer.run('chat-1');
  if (phase === 'commit') {
    await f.entered.promise;
    f.tickets[0].validate.mockImplementation(() => { throw failure; });
    f.ready.resolve();
  }
  await running;
  const control = await f.controls.read('chat-1');
  expect(control.entries.map((entry) => entry.content)).toEqual(['synthetic original']);
  expect(control.pause).toMatchObject({ kind: 'queued-turn-failed', entryId: f.created.entryId });
  expect(f.callbacks.publishTurnFailed).toHaveBeenCalledOnce();
  expect(f.runner.runAgentTurn).not.toHaveBeenCalled();
  expect(f.runner.prepareTurn).toHaveBeenCalledOnce();
  if (phase === 'commit') expect(f.tickets[0].release).toHaveBeenCalledOnce();
});

test('Stop after the dequeue commits prevents attempt installation and dispatch', async () => {
  const f = await fixture();
  const dequeue = f.controls.dequeueNextTurn.bind(f.controls);
  f.controls.dequeueNextTurn = async (...args) => {
    const result = await dequeue(...args);
    if (result?.inserted) {
      f.ownership.enterManualStop('chat-1');
      f.ownership.abortAdmission('chat-1', new Error('synthetic Stop'));
    }
    return result;
  };
  f.ready.resolve();
  await f.drainer.run('chat-1');
  expect(f.callbacks.registerQueued).toHaveBeenCalledOnce();
  expect((await f.controls.read('chat-1')).entries).toEqual([]);
  expect(f.runner.runAgentTurn).not.toHaveBeenCalled();
  expect(f.ownership.attempt('chat-1')).toBeUndefined();
  expect(f.callbacks.discardPreparedInput).toHaveBeenCalledWith('chat-1', f.tickets[0].options.clientMessageId);
  expect(f.tickets[0].release).toHaveBeenCalledOnce();
});

test.each(['prepare', 'commit'])('consumes a control rejected during %s and drains the following user input once', async (phase) => {
  const f = await fixture();
  await f.controls.enqueueControl('chat-1', {
    content: 'synthetic rejected control', transcriptViewId: 'synthetic-view',
    createdAt: '2026-01-01T00:00:00.000Z', receipt: null,
  });
  const failure = new DomainError('SESSION_BUSY', 'synthetic changed binding', 409, true);
  if (phase === 'prepare') f.runner.prepareTurn.mockImplementationOnce(async () => { throw failure; });
  const running = f.drainer.run('chat-1');
  if (phase === 'commit') {
    await f.entered.promise;
    f.tickets[0].validate.mockImplementation(() => { throw failure; });
  }
  f.ready.resolve();
  await running;
  expect((await f.controls.read('chat-1')).controlEntries).toEqual([]);
  await f.drainer.run('chat-1');
  const control = await f.controls.read('chat-1');
  expect(control.controlEntries).toEqual([]);
  expect(control.entries).toEqual([]);
  expect(control.pause).toBeNull();
  expect(f.callbacks.appendControlReceipt).not.toHaveBeenCalled();
  expect(f.callbacks.publishTurnFailed).toHaveBeenCalledOnce();
  expect(f.runner.runAgentTurn).toHaveBeenCalledOnce();
  expect(f.runner.runAgentTurn.mock.calls[0][1]).toBe('synthetic original');
  expect(f.runner.prepareTurn).toHaveBeenCalledTimes(2);
});

test.each(['replace', 'stop'])('a failing control preparation cannot consume a %s during its wait', async (interleaving) => {
  const f = await fixture();
  const input = { content: 'synthetic control', transcriptViewId: 'synthetic-view',
    createdAt: '2026-01-01T00:00:00.000Z', receipt: null };
  await f.controls.enqueueControl('chat-1', input);
  f.runner.prepareTurn.mockImplementationOnce(async () => {
    f.entered.resolve();
    await f.ready.promise;
    throw new Error('synthetic preparation failure');
  });
  const running = f.drainer.run('chat-1');
  await f.entered.promise;
  if (interleaving === 'replace') {
    await f.controls.discardPendingInput('chat-1');
    await f.controls.enqueueControl('chat-1', { ...input, content: 'synthetic replacement' });
  } else {
    f.ownership.enterManualStop('chat-1');
    f.ownership.abortAdmission('chat-1', new Error('synthetic Stop'));
  }
  f.ready.resolve();
  await running;
  expect(f.callbacks.publishTurnFailed).not.toHaveBeenCalled();
  if (interleaving === 'replace') {
    expect(f.runner.runAgentTurn).toHaveBeenCalledOnce();
    expect(f.runner.runAgentTurn.mock.calls[0][1]).toBe('synthetic replacement');
    expect(f.callbacks.appendControlReceipt).toHaveBeenCalledOnce();
  } else {
    expect(f.runner.runAgentTurn).not.toHaveBeenCalled();
    expect((await f.controls.read('chat-1')).controlEntries).toHaveLength(1);
  }
});

test('Stop while a failed control waits to be discarded leaves it queued', async () => {
  const f = await fixture();
  await f.controls.enqueueControl('chat-1', {
    content: 'synthetic control', transcriptViewId: 'synthetic-view',
    createdAt: '2026-01-01T00:00:00.000Z', receipt: null,
  });
  f.runner.prepareTurn.mockImplementation(async () => { throw new Error('synthetic preparation failure'); });
  const dequeue = f.controls.dequeueNextTurn.bind(f.controls);
  f.controls.dequeueNextTurn = async (...args) => {
    f.ownership.enterManualStop('chat-1');
    f.ownership.abortAdmission('chat-1', new Error('synthetic Stop'));
    return dequeue(...args);
  };
  await f.drainer.run('chat-1');
  expect((await f.controls.read('chat-1')).controlEntries).toHaveLength(1);
  expect(f.callbacks.publishTurnFailed).not.toHaveBeenCalled();
  expect(f.runner.runAgentTurn).not.toHaveBeenCalled();
});

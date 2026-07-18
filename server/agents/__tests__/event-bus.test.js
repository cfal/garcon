import { afterEach, describe, expect, it, mock } from 'bun:test';
import { AgentEventBus } from '../event-bus.js';

const originalWarn = console.warn;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;

afterEach(() => {
  console.warn = originalWarn;
  if (originalLogLevel === undefined) {
    delete process.env.GARCON_LOG_LEVEL;
  } else {
    process.env.GARCON_LOG_LEVEL = originalLogLevel;
  }
});

describe('AgentEventBus', () => {

  it('resolves an abortable waiter only for its exact active turn', async () => {
    let emitProcessing;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onProcessing: (cb) => { emitProcessing = cb; },
        },
      }],
    });
    const forwarded = [];
    bus.onProcessing((chatId, isProcessing) => forwarded.push({ chatId, isProcessing }));
    bus.trackTurn('chat-1', { clientRequestId: 'req-1', turnId: 'turn-1' });
    let settled = false;
    const abortable = bus.waitUntilTurnAbortable(
      'chat-1',
      { clientRequestId: 'req-1', turnId: 'turn-1' },
    ).then((value) => {
      settled = true;
      return value;
    });

    bus.markTurnAbortable('chat-1', { clientRequestId: 'req-old', turnId: 'turn-old' });
    await Promise.resolve();
    expect(settled).toBe(false);

    bus.markTurnAbortable('chat-1', { clientRequestId: 'req-1', turnId: 'turn-1' });
    await expect(abortable).resolves.toBe(true);
    expect(forwarded).toEqual([]);
    emitProcessing('chat-1', true);
    expect(forwarded).toEqual([{ chatId: 'chat-1', isProcessing: true }]);
  });

  it('removes a runtime-start waiter when its owner aborts the wait', async () => {
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onProcessing: () => undefined,
        },
      }],
    });
    const controller = new AbortController();
    bus.trackTurn('chat-1', { turnId: 'turn-1' });
    const abortable = bus.waitUntilTurnAbortable('chat-1', { turnId: 'turn-1' }, controller.signal);

    controller.abort();
    await expect(abortable).resolves.toBe(false);
  });

  it('does not reuse cached abortability across turn identities', async () => {
    const bus = new AgentEventBus({ list: () => [] });
    bus.trackTurn('chat-1', { turnId: 'turn-1' });
    bus.markTurnAbortable('chat-1', { turnId: 'turn-1' });
    bus.trackTurn('chat-1', { turnId: 'turn-2' });

    const controller = new AbortController();
    const abortable = bus.waitUntilTurnAbortable('chat-1', { turnId: 'turn-2' }, controller.signal);
    controller.abort();

    await expect(abortable).resolves.toBe(false);
  });

  it('returns a defensive snapshot of the active turn identity', () => {
    const bus = new AgentEventBus({ list: () => [] });
    bus.trackTurn('chat-1', { clientRequestId: 'req-1', turnId: 'turn-1' });

    const snapshot = bus.getActiveTurn('chat-1');
    snapshot.turnId = 'mutated';

    expect(bus.getActiveTurn('chat-1')).toEqual({
      clientRequestId: 'req-1',
      commandType: undefined,
      turnId: 'turn-1',
    });
  });

  it('warns when turn metadata is overwritten before a terminal event', () => {
    process.env.GARCON_LOG_LEVEL = 'warn';
    console.warn = mock(() => undefined);
    const bus = new AgentEventBus({ list: () => [] });

    bus.trackTurn('chat-1', { clientRequestId: 'req-1' });
    bus.trackTurn('chat-1', { clientRequestId: 'req-2' });

    expect(console.warn).toHaveBeenCalledWith(
      '[agents:event-bus]',
      'agents: overwriting in-flight turn metadata for chat',
      'chat-1',
    );
  });

  it('retains exact identity through duplicate terminals until queue settlement', () => {
    let emitFinished;
    let emitFailed;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onFinished: (cb) => { emitFinished = cb; },
          onFailed: (cb) => { emitFailed = cb; },
        },
      }],
    });
    const terminals = [];
    bus.onFinished((_chatId, _exitCode, turn) => terminals.push({ kind: 'finished', turn }));
    bus.onFailed((_chatId, _message, turn) => terminals.push({ kind: 'failed', turn }));
    bus.trackTurn('chat-1', { clientRequestId: 'req-a', turnId: 'turn-a' });

    emitFinished('chat-1', 0, { clientRequestId: 'req-a', turnId: 'turn-a' });
    emitFailed('chat-1', 'duplicate terminal', {
      clientRequestId: 'req-a',
      turnId: 'turn-a',
    });

    expect(terminals).toEqual([
      {
        kind: 'finished',
        turn: { clientRequestId: 'req-a', turnId: 'turn-a' },
      },
      {
        kind: 'failed',
        turn: { clientRequestId: 'req-a', turnId: 'turn-a' },
      },
    ]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-a');

    bus.settleTurn('chat-1', { turnId: 'turn-a' });
    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
  });

  it('drops a stale identified terminal instead of assigning it to the successor', () => {
    let emitFailed;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onFailed: (cb) => { emitFailed = cb; },
        },
      }],
    });
    const terminals = [];
    bus.onFailed((_chatId, _message, turn) => terminals.push(turn));
    bus.trackTurn('chat-1', { clientRequestId: 'req-b', turnId: 'turn-b' });

    emitFailed('chat-1', 'late A failure', {
      clientRequestId: 'req-a',
      turnId: 'turn-a',
    });

    expect(terminals).toEqual([]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-b');
  });

  it('drops an identityless terminal while an identified turn is active', async () => {
    let emitFinished;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onFinished: (cb) => { emitFinished = cb; },
        },
      }],
    });
    const terminals = [];
    bus.onFinished((_chatId, _exitCode, turn) => terminals.push(turn));
    bus.trackTurn('chat-1', { clientRequestId: 'req-b', turnId: 'turn-b' });
    bus.markTurnAbortable('chat-1', { clientRequestId: 'req-b', turnId: 'turn-b' });

    emitFinished('chat-1', 0, undefined);

    expect(terminals).toEqual([]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-b');
    await expect(bus.waitUntilTurnAbortable('chat-1', {
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    })).resolves.toBe(true);
  });

  it('drops stale identified output instead of assigning it to the successor', () => {
    let emitMessages;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onMessages: (cb) => { emitMessages = cb; },
        },
      }],
    });
    const received = [];
    bus.onMessages((chatId, messages, metadata) => received.push({ chatId, messages, metadata }));
    bus.trackTurn('chat-1', { clientRequestId: 'req-b', turnId: 'turn-b' });

    emitMessages('chat-1', ['late A output'], {
      clientRequestId: 'req-a',
      turnId: 'turn-a',
    });
    emitMessages('chat-1', ['current B output'], {
      clientRequestId: 'req-b',
      turnId: 'turn-b',
    });

    expect(received).toEqual([{
      chatId: 'chat-1',
      messages: ['current B output'],
      metadata: { clientRequestId: 'req-b', turnId: 'turn-b' },
    }]);
  });

  it('keeps the queue-owned command type when a runtime reports its fallback type', () => {
    let emitFinished;
    const bus = new AgentEventBus({
      list: () => [{
        runtime: {
          onFinished: (cb) => { emitFinished = cb; },
        },
      }],
    });
    const terminals = [];
    bus.onFinished((_chatId, _exitCode, turn) => terminals.push(turn));
    bus.trackTurn('chat-1', {
      clientRequestId: 'req-run',
      commandType: 'agent-run',
      turnId: 'turn-run',
    });

    emitFinished('chat-1', 0, {
      clientRequestId: 'req-run',
      commandType: 'chat-start',
      turnId: 'turn-run',
    });

    expect(terminals).toEqual([{
      clientRequestId: 'req-run',
      commandType: 'agent-run',
      turnId: 'turn-run',
    }]);
  });

  it('discards retained identity and abortability when a chat is removed', async () => {
    const bus = new AgentEventBus({ list: () => [] });
    bus.trackTurn('chat-1', { clientRequestId: 'req-a', turnId: 'turn-a' });
    const waiting = bus.waitUntilTurnAbortable('chat-1', { turnId: 'turn-a' });

    bus.clearTurn('chat-1');

    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
    await expect(waiting).resolves.toBe(false);
  });
});

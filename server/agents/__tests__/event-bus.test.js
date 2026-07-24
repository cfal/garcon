import { afterEach, describe, expect, it, mock } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { UserMessage } from '../../../common/chat-types.js';
import { AgentEventBus } from '../event-bus.js';

const originalWarn = console.warn;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;

afterEach(() => {
  console.warn = originalWarn;
  if (originalLogLevel === undefined) delete process.env.GARCON_LOG_LEVEL;
  else process.env.GARCON_LOG_LEVEL = originalLogLevel;
});

function operation(turnId, clientRequestId = `request-${turnId}`, commandType = 'agent-run') {
  return { commandType, clientRequestId, clientMessageId: null, turnId };
}

function makeBus() {
  let emit;
  const unsubscribe = mock(() => undefined);
  const bus = new AgentEventBus({
    list: () => [{ execution: { subscribe(listener) { emit = listener; return unsubscribe; } } }],
  });
  return { bus, emit: (event) => emit(event), unsubscribe };
}

function terminalHandoff(overrides = {}) {
  return {
    validate: overrides.validate ?? (() => undefined),
    commit: overrides.commit ?? (() => undefined),
  };
}

describe('AgentEventBus', () => {
  it('resolves an abortable waiter only for its exact active operation', async () => {
    const { bus, emit } = makeBus();
    const forwarded = [];
    bus.onProcessing((chatId, processing) => forwarded.push({ chatId, processing }));
    bus.trackTurn('chat-1', operation('turn-1'));
    let settled = false;
    const abortable = bus.waitUntilTurnAbortable('chat-1', operation('turn-1')).then((value) => {
      settled = true;
      return value;
    });

    bus.markTurnAbortable('chat-1', operation('turn-old'));
    await Promise.resolve();
    expect(settled).toBe(false);
    bus.markTurnAbortable('chat-1', operation('turn-1'));
    await expect(abortable).resolves.toBe(true);

    emit({ type: 'processing', chatId: 'chat-1', processing: true, operation: operation('turn-1') });
    expect(forwarded).toEqual([{ chatId: 'chat-1', processing: true }]);
  });

  it('removes an abortability waiter when its owner cancels', async () => {
    const { bus } = makeBus();
    const controller = new AbortController();
    bus.trackTurn('chat-1', operation('turn-1'));
    const waiting = bus.waitUntilTurnAbortable('chat-1', operation('turn-1'), controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it('transfers abortability across an active-input identity handoff', async () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    bus.markTurnAbortable('chat-1', operation('turn-1'));
    const handoff = bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      terminalHandoff(),
    );
    handoff.validate();
    handoff.commit();
    await expect(bus.waitUntilTurnAbortable('chat-1', operation('turn-2'))).resolves.toBe(true);
  });

  it('returns a defensive snapshot and rejects an active identity overwrite', () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    const snapshot = bus.getActiveTurn('chat-1');
    snapshot.turnId = 'mutated';

    expect(() => bus.trackTurn('chat-1', operation('turn-2'))).toThrow(
      'Cannot track a new turn while chat chat-1 has an active turn',
    );
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
  });

  it('commits an explicit active-input identity handoff at its delivery boundary', () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-1'));

    const handoff = bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      terminalHandoff(),
    );
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
    handoff.validate();
    handoff.commit();

    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-2');
  });

  it('keeps predecessor output attributable while successor persistence is pending', () => {
    const { bus, emit } = makeBus();
    const forwarded = [];
    bus.onMessages((_chatId, messages, metadata) => {
      forwarded.push({ content: messages[0].content, turnId: metadata.turnId });
    });
    bus.trackTurn('chat-1', operation('turn-a'));
    bus.handoffTurn(
      'chat-1',
      operation('turn-a'),
      operation('turn-b'),
      terminalHandoff(),
    );

    emit({
      type: 'messages',
      chatId: 'chat-1',
      messages: [new UserMessage('2026-07-18T00:00:00.000Z', 'predecessor output')],
      operation: operation('turn-a'),
    });
    emit({
      type: 'messages',
      chatId: 'chat-1',
      messages: [new UserMessage('2026-07-18T00:00:01.000Z', 'uncommitted successor output')],
      operation: operation('turn-b'),
    });

    expect(forwarded).toEqual([{ content: 'predecessor output', turnId: 'turn-a' }]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-a');
  });

  it('leaves the predecessor active when downstream validation fails before commit', async () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    bus.markTurnAbortable('chat-1', operation('turn-1'));

    const handoff = bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      terminalHandoff({
        validate: () => { throw new Error('registration failed'); },
      }),
    );
    expect(() => handoff.validate()).toThrow('registration failed');

    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
    await expect(bus.waitUntilTurnAbortable('chat-1', operation('turn-1'))).resolves.toBe(true);
  });

  it('rejects a handoff after the predecessor identity has changed', () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    bus.settleTurn('chat-1', operation('turn-1'));
    bus.trackTurn('chat-1', operation('turn-3'));

    expect(() => bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      terminalHandoff(),
    )).toThrow('active turn changed');
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-3');
  });

  it('retains exact identity through duplicate terminal events until settlement', () => {
    const { bus, emit } = makeBus();
    const terminals = [];
    bus.onFinished((_chatId, _exitCode, turn) => terminals.push({ type: 'finished', turn }));
    bus.onFailed((_chatId, _message, turn) => terminals.push({ type: 'failed', turn }));
    const active = operation('turn-a', 'request-a');
    bus.trackTurn('chat-1', active);

    emit({ type: 'finished', chatId: 'chat-1', exitCode: 0, operation: active });
    emit({
      type: 'failed',
      chatId: 'chat-1',
      error: new AgentIntegrationError('PROVIDER_FAILURE', 'duplicate terminal'),
      operation: active,
    });

    expect(terminals).toEqual([
      { type: 'finished', turn: { clientRequestId: 'request-a', commandType: 'agent-run', turnId: 'turn-a' } },
      { type: 'failed', turn: { clientRequestId: 'request-a', commandType: 'agent-run', turnId: 'turn-a' } },
    ]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-a');
    bus.settleTurn('chat-1', active);
    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
  });

  it('drops stale output and terminals instead of assigning them to a successor', () => {
    const { bus, emit } = makeBus();
    const messages = [];
    const failures = [];
    bus.onMessages((_chatId, received) => messages.push(...received));
    bus.onFailed((_chatId, message) => failures.push(message));
    bus.trackTurn('chat-1', operation('turn-b', 'request-b'));

    emit({
      type: 'messages',
      chatId: 'chat-1',
      messages: [new UserMessage('2026-07-18T00:00:00.000Z', 'stale')],
      operation: operation('turn-a', 'request-a'),
    });
    emit({
      type: 'failed',
      chatId: 'chat-1',
      error: new AgentIntegrationError('PROVIDER_FAILURE', 'stale failure'),
      operation: operation('turn-a', 'request-a'),
    });
    emit({
      type: 'messages',
      chatId: 'chat-1',
      messages: [new UserMessage('2026-07-18T00:00:01.000Z', 'current')],
      operation: operation('turn-b', 'request-b'),
    });

    expect(messages.map((message) => message.content)).toEqual(['current']);
    expect(failures).toEqual([]);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-b');
  });

  it('discards retained identity and abortability when a chat is removed', async () => {
    const { bus } = makeBus();
    bus.trackTurn('chat-1', operation('turn-a'));
    const waiting = bus.waitUntilTurnAbortable('chat-1', operation('turn-a'));
    bus.clearTurn('chat-1');
    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
    await expect(waiting).resolves.toBe(false);
  });
});

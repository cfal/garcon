import { afterEach, describe, expect, it, mock } from 'bun:test';
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

function terminalHandoff(overrides = {}) {
  return {
    validate: overrides.validate ?? (() => undefined),
    commit: overrides.commit ?? (() => undefined),
  };
}

function runEnded(outcome, error) {
  return {
    ordinal: 1,
    at: '2026-08-12T00:00:00.000Z',
    providerMeta: null,
    kind: 'run-ended',
    outcome,
    origin: 'provider',
    ...(error ? { error } : {}),
  };
}

describe('AgentEventBus', () => {
  it('returns a defensive snapshot and rejects an active identity overwrite', () => {
    const bus = new AgentEventBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    const snapshot = bus.getActiveTurn('chat-1');
    snapshot.turnId = 'mutated';

    expect(() => bus.trackTurn('chat-1', operation('turn-2'))).toThrow(
      'Cannot track a new turn while chat chat-1 has an active turn',
    );
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
  });

  it('commits a goal-control identity handoff at its delivery boundary', () => {
    const bus = new AgentEventBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    const downstream = terminalHandoff({
      validate: mock(() => undefined),
      commit: mock(() => undefined),
    });

    const handoff = bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      downstream,
    );
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
    handoff.validate();
    handoff.commit();

    expect(downstream.validate).toHaveBeenCalledTimes(1);
    expect(downstream.commit).toHaveBeenCalledTimes(1);
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-2');
  });

  it('leaves the predecessor active when downstream validation fails', () => {
    const bus = new AgentEventBus();
    bus.trackTurn('chat-1', operation('turn-1'));
    const handoff = bus.handoffTurn(
      'chat-1',
      operation('turn-1'),
      operation('turn-2'),
      terminalHandoff({ validate: () => { throw new Error('registration failed'); } }),
    );

    expect(() => handoff.validate()).toThrow('registration failed');
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-1');
  });

  it('rejects a handoff after the predecessor identity changes', () => {
    const bus = new AgentEventBus();
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

  it('publishes one matching terminal and clears the active turn', async () => {
    const bus = new AgentEventBus();
    const finished = mock(() => undefined);
    bus.onFinished(finished);
    bus.trackTurn('chat-1', operation('turn-1'));

    await bus.publishRunEnded('chat-1', 'turn-1', runEnded('finished'));

    expect(finished).toHaveBeenCalledWith(
      'chat-1',
      0,
      expect.objectContaining({ clientRequestId: 'request-turn-1', turnId: 'turn-1' }),
      'finished',
    );
    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
  });

  it('routes failed terminal detail after scheduler settlement', async () => {
    const bus = new AgentEventBus();
    const failed = mock(() => undefined);
    bus.onFailed(failed);
    bus.trackTurn('chat-1', operation('turn-1'));
    bus.settleTurn('chat-1', operation('turn-1'));

    await bus.publishRunEnded(
      'chat-1',
      'turn-1',
      runEnded('failed', { code: 'START_FAILED', message: 'Could not start' }),
    );

    expect(failed).toHaveBeenCalledWith(
      'chat-1',
      'Could not start',
      'START_FAILED',
      expect.objectContaining({ turnId: 'turn-1' }),
    );
  });

  it('ignores stale terminal signals instead of assigning them to a successor', async () => {
    const bus = new AgentEventBus();
    const finished = mock(() => undefined);
    bus.onFinished(finished);
    bus.trackTurn('chat-1', operation('turn-2'));

    await bus.publishRunEnded('chat-1', 'turn-1', runEnded('interrupted'));

    expect(finished).not.toHaveBeenCalled();
    expect(bus.getActiveTurn('chat-1')?.turnId).toBe('turn-2');
  });

  it('publishes session facts independently of run correlation', async () => {
    const bus = new AgentEventBus();
    const created = mock(() => undefined);
    bus.onSessionCreated(created);

    await bus.publishSession('chat-1');

    expect(created).toHaveBeenCalledWith('chat-1');
  });

  it('clears turn correlation without suppressing the run-activity signal', async () => {
    const bus = new AgentEventBus();
    const finished = mock(() => undefined);
    const activityCleared = mock(() => undefined);
    bus.onFinished(finished);
    bus.onRunActivityCleared(activityCleared);
    bus.trackTurn('chat-1', operation('turn-1'));
    bus.settleTurn('chat-1', operation('turn-1'));
    bus.clearTurn('chat-1');

    await bus.publishRunEnded('chat-1', 'turn-1', runEnded('finished'));

    expect(bus.getActiveTurn('chat-1')).toBeUndefined();
    expect(finished).not.toHaveBeenCalled();
    expect(activityCleared).toHaveBeenCalledWith('chat-1');
  });
});

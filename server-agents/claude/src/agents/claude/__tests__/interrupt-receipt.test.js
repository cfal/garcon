import { describe, expect, it } from 'bun:test';
import { ClaudeActiveTurn } from '../active-turn.js';
import { handleClaudeInterruptReceipt } from '../interrupt-receipt.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createFixture({ settleOnFlush = false } = {}) {
  const activeTurn = new ClaudeActiveTurn(0, {
    runId: 'run-1',
    publish() {},
  });
  const session = {
    id: 'session-1',
    chatId: 'chat-1',
    activeTurn,
    process: { pid: 42 },
  };
  const calls = [];
  const handlers = {
    logger,
    finish: () => calls.push('finish'),
    clearAbortTimer: () => calls.push('clear'),
    armCompletionFallback: () => calls.push('arm'),
    flushDeferredIdle: () => {
      calls.push('flush');
      if (settleOnFlush) session.activeTurn = null;
    },
  };
  return { activeTurn, session, calls, handlers };
}

function startInput(activeTurn) {
  activeTurn.protocol.observeInput({
    type: 'command_lifecycle',
    command_uuid: activeTurn.protocol.inputUuid,
    state: 'started',
  });
}

describe('handleClaudeInterruptReceipt', () => {
  it('finishes a current pre-start input confirmed cancelled', () => {
    const fixture = createFixture();

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { cancelled: [fixture.activeTurn.protocol.inputUuid] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.calls).toEqual(['finish']);
  });

  it('rejects a pre-start receipt that leaves the input queued', () => {
    const fixture = createFixture();

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { still_queued: [fixture.activeTurn.protocol.inputUuid] },
      fixture.handlers,
    )).toBe(false);
    expect(fixture.calls).toEqual(['clear']);
    expect(fixture.activeTurn.protocol.abortRequested).toBe(false);
  });

  it('arms the completion fallback for an acknowledged started input', () => {
    const fixture = createFixture();
    startInput(fixture.activeTurn);

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { cancelled: [], still_queued: [] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.calls).toEqual(['arm']);
  });

  it('does not mutate a replacement active turn', () => {
    const fixture = createFixture();
    startInput(fixture.activeTurn);
    fixture.session.activeTurn = new ClaudeActiveTurn(0, {
      runId: 'run-2',
      publish() {},
    });

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { cancelled: [], still_queued: [] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.calls).toEqual([]);
  });

  it('cancels only steering UUIDs owned by the active turn', () => {
    const fixture = createFixture();
    startInput(fixture.activeTurn);
    fixture.activeTurn.steering.markSubmitted('steer-1');

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { cancelled: ['steer-1', 'provider-internal'] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.activeTurn.steering.blocksIdleSettlement).toBe(false);
    expect(fixture.calls).toEqual(['flush', 'arm']);
  });

  it('does not arm a fallback after cancellation flush settles the turn', () => {
    const fixture = createFixture({ settleOnFlush: true });
    startInput(fixture.activeTurn);
    fixture.activeTurn.protocol.recordAcceptedResult({
      type: 'result',
      user_message_uuid: fixture.activeTurn.protocol.inputUuid,
    });
    fixture.activeTurn.steering.markSubmitted('steer-1');
    fixture.activeTurn.steering.rememberProviderIdle();

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { cancelled: ['steer-1'] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.session.activeTurn).toBeNull();
    expect(fixture.calls).toEqual(['flush']);
  });

  it('retains a steering fence reported still queued', () => {
    const fixture = createFixture();
    startInput(fixture.activeTurn);
    fixture.activeTurn.steering.markSubmitted('steer-1');

    expect(handleClaudeInterruptReceipt(
      fixture.session,
      fixture.activeTurn,
      { still_queued: ['steer-1'] },
      fixture.handlers,
    )).toBe(true);
    expect(fixture.activeTurn.steering.blocksIdleSettlement).toBe(true);
    expect(fixture.calls).toEqual(['clear', 'arm']);
  });
});

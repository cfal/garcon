import { describe, expect, it, mock } from 'bun:test';
import { UserAbortLifecycleCoordinator } from '../user-abort-lifecycle-coordinator.js';

function createHarness() {
  const cohort = { chatId: 'chat-1', records: [] };
  const pendingInputs = {
    captureCohort: mock(() => cohort),
    settleNativeCohort: mock(async () => undefined),
  };
  const coordinator = new UserAbortLifecycleCoordinator(pendingInputs, {
    terminalTimeoutMs: 60_000,
  });
  return { cohort, coordinator, pendingInputs };
}

describe('UserAbortLifecycleCoordinator', () => {
  it('settles and suppresses only the exact interrupted turn', () => {
    const { cohort, coordinator, pendingInputs } = createHarness();
    const interrupted = { clientRequestId: 'req-a', turnId: 'turn-a' };
    const successor = { clientRequestId: 'req-b', turnId: 'turn-b' };

    coordinator.onStopRequested('chat-1', 'stop-a', interrupted);
    expect(coordinator.onSessionStopped('chat-1', 'stop-a', true)).toEqual({
      terminalDisposition: 'none',
      turn: interrupted,
    });

    expect(coordinator.onTurnTerminal('chat-1', successor)).toBe(false);
    expect(pendingInputs.settleNativeCohort).not.toHaveBeenCalled();

    expect(coordinator.onTurnTerminal('chat-1', interrupted)).toBe('first');
    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledWith(cohort);
    expect(coordinator.onTurnTerminal('chat-1', interrupted)).toBe('duplicate');

    coordinator.onTurnSettled('chat-1', interrupted);
    expect(coordinator.onTurnTerminal('chat-1', interrupted)).toBe(false);
  });

  it('requests ordinary reconciliation when a terminal precedes a rejected stop', () => {
    const { coordinator, pendingInputs } = createHarness();
    const turn = { clientRequestId: 'req-a', turnId: 'turn-a' };

    coordinator.onStopRequested('chat-1', 'stop-a', turn);
    expect(coordinator.onTurnTerminal('chat-1', turn)).toBe('deferred');
    coordinator.onTurnSettled('chat-1', turn);
    expect(coordinator.onSessionStopped('chat-1', 'stop-a', false)).toEqual({
      terminalDisposition: 'release',
      turn,
    });
    expect(pendingInputs.settleNativeCohort).not.toHaveBeenCalled();
    expect(coordinator.onTurnTerminal('chat-1', turn)).toBe(false);
  });

  it('suppresses a deferred terminal only after a successful stop acknowledgement', () => {
    const { cohort, coordinator, pendingInputs } = createHarness();
    const turn = { clientRequestId: 'req-a', turnId: 'turn-a' };

    coordinator.onStopRequested('chat-1', 'stop-a', turn);
    expect(coordinator.onTurnTerminal('chat-1', turn)).toBe('deferred');
    coordinator.onTurnSettled('chat-1', turn);
    expect(coordinator.onSessionStopped('chat-1', 'stop-a', true)).toEqual({
      terminalDisposition: 'suppress',
      turn,
    });

    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledWith(cohort);
    expect(coordinator.onTurnTerminal('chat-1', turn)).toBe(false);
  });

  it('discards settlement and suppression state together when a chat is removed', () => {
    const { coordinator, pendingInputs } = createHarness();
    const turn = { clientRequestId: 'req-a', turnId: 'turn-a' };

    coordinator.onStopRequested('chat-1', 'stop-a', turn);
    coordinator.discard('chat-1');

    expect(coordinator.onTurnTerminal('chat-1', turn)).toBe(false);
    expect(pendingInputs.settleNativeCohort).not.toHaveBeenCalled();
  });
});

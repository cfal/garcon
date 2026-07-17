import { describe, expect, it, mock } from 'bun:test';
import { StopSettlementCoordinator } from '../stop-settlement-coordinator.js';

function createFixture() {
  const cohort = Object.freeze({ chatId: 'chat-1', records: Object.freeze([]) });
  const pendingInputs = {
    captureCohort: mock(() => cohort),
    settleNativeCohort: mock(async () => undefined),
  };
  const coordinator = new StopSettlementCoordinator(pendingInputs, {
    terminalTimeoutMs: 60_000,
  });
  return { cohort, coordinator, pendingInputs };
}

describe('StopSettlementCoordinator', () => {
  it('captures the settlement cohort synchronously when stop is requested', () => {
    const { coordinator, pendingInputs } = createFixture();

    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });

    expect(pendingInputs.captureCohort).toHaveBeenCalledWith('chat-1');
  });

  it('waits for the interrupted turn terminal event before settling', async () => {
    const { cohort, coordinator, pendingInputs } = createFixture();
    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });
    coordinator.onSessionStopped('chat-1', true);

    coordinator.onTurnTerminal('chat-1', { turnId: 'turn-b' });
    await Promise.resolve();
    expect(pendingInputs.settleNativeCohort).not.toHaveBeenCalled();

    coordinator.onTurnTerminal('chat-1', { turnId: 'turn-a' });
    await Promise.resolve();
    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledWith(cohort);
  });

  it('remembers a terminal event that arrives before the stop acknowledgement', async () => {
    const { cohort, coordinator, pendingInputs } = createFixture();
    coordinator.onStopRequested('chat-1', { clientRequestId: 'req-a' });
    coordinator.onTurnTerminal('chat-1', { clientRequestId: 'req-a' });

    coordinator.onSessionStopped('chat-1', true);
    await Promise.resolve();

    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledWith(cohort);
  });

  it('discards the cohort when the runtime rejects the stop', async () => {
    const { coordinator, pendingInputs } = createFixture();
    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });

    coordinator.onSessionStopped('chat-1', false);
    coordinator.onTurnTerminal('chat-1', { turnId: 'turn-a' });
    await Promise.resolve();

    expect(pendingInputs.settleNativeCohort).not.toHaveBeenCalled();
  });

  it('settles after a bounded timeout when the runtime emits no terminal event', async () => {
    const cohort = Object.freeze({ chatId: 'chat-1', records: Object.freeze([]) });
    const pendingInputs = {
      captureCohort: mock(() => cohort),
      settleNativeCohort: mock(async () => undefined),
    };
    const coordinator = new StopSettlementCoordinator(pendingInputs, { terminalTimeoutMs: 0 });
    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });

    coordinator.onSessionStopped('chat-1', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledWith(cohort);
  });

  it('coalesces repeated stop requests for the same chat', () => {
    const { coordinator, pendingInputs } = createFixture();

    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });
    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });

    expect(pendingInputs.captureCohort).toHaveBeenCalledTimes(1);
    coordinator.discard('chat-1');
  });

  it('re-arms one timeout when a successful acknowledgement is repeated', async () => {
    const { coordinator, pendingInputs } = createFixture();
    coordinator.onStopRequested('chat-1', { turnId: 'turn-a' });
    coordinator.onSessionStopped('chat-1', true);
    coordinator.onSessionStopped('chat-1', true);

    coordinator.onTurnTerminal('chat-1', { turnId: 'turn-a' });
    await Promise.resolve();

    expect(pendingInputs.settleNativeCohort).toHaveBeenCalledTimes(1);
  });
});

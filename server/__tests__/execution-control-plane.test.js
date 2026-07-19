import { describe, expect, it, mock } from 'bun:test';
import { startExecutionControlPlane } from '../execution-control-plane.js';

describe('execution control plane startup', () => {
  it('installs terminal consumers before recovered work can dispatch', async () => {
    let onTerminal;
    const settled = [];
    const wireEvents = mock(() => {
      onTerminal = (turnId) => settled.push(turnId);
      return { waitForIdle: mock(async () => undefined) };
    });
    const recoverControls = mock(async () => {
      onTerminal('recovered-turn');
    });
    const activateRecoveredSettlement = mock(async () => {
      settled.push('settlement-activated');
    });
    const startScheduledPrompts = mock(async () => undefined);

    const wiring = await startExecutionControlPlane({
      wireEvents,
      recoverControls,
      activateRecoveredSettlement,
      startScheduledPrompts,
    });

    expect(settled).toEqual(['recovered-turn', 'settlement-activated']);
    expect(wireEvents).toHaveBeenCalledTimes(1);
    expect(recoverControls).toHaveBeenCalledTimes(1);
    expect(activateRecoveredSettlement).toHaveBeenCalledTimes(1);
    expect(startScheduledPrompts).toHaveBeenCalledTimes(1);
    expect(wiring.waitForIdle).toBeDefined();
  });

  it('does not start scheduled producers when recovery fails', async () => {
    const startScheduledPrompts = mock(async () => undefined);

    await expect(startExecutionControlPlane({
      wireEvents: () => ({}),
      recoverControls: async () => { throw new Error('recovery failed'); },
      activateRecoveredSettlement: async () => undefined,
      startScheduledPrompts,
    })).rejects.toThrow('recovery failed');

    expect(startScheduledPrompts).not.toHaveBeenCalled();
  });

  it('does not start scheduled producers when settlement activation fails', async () => {
    const startScheduledPrompts = mock(async () => undefined);

    await expect(startExecutionControlPlane({
      wireEvents: () => ({}),
      recoverControls: async () => undefined,
      activateRecoveredSettlement: async () => { throw new Error('activation failed'); },
      startScheduledPrompts,
    })).rejects.toThrow('activation failed');

    expect(startScheduledPrompts).not.toHaveBeenCalled();
  });
});

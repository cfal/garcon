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
    const recoverQueues = mock(async () => {
      onTerminal('recovered-turn');
    });
    const startScheduledPrompts = mock(async () => undefined);

    const wiring = await startExecutionControlPlane({
      wireEvents,
      recoverQueues,
      startScheduledPrompts,
    });

    expect(settled).toEqual(['recovered-turn']);
    expect(wireEvents).toHaveBeenCalledTimes(1);
    expect(recoverQueues).toHaveBeenCalledTimes(1);
    expect(startScheduledPrompts).toHaveBeenCalledTimes(1);
    expect(wiring.waitForIdle).toBeDefined();
  });

  it('does not start scheduled producers when recovery fails', async () => {
    const startScheduledPrompts = mock(async () => undefined);

    await expect(startExecutionControlPlane({
      wireEvents: () => ({}),
      recoverQueues: async () => { throw new Error('recovery failed'); },
      startScheduledPrompts,
    })).rejects.toThrow('recovery failed');

    expect(startScheduledPrompts).not.toHaveBeenCalled();
  });
});

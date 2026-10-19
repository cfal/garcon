import { describe, expect, it, mock } from 'bun:test';
import { startExecutionControlPlane } from '../execution-control-plane.js';

describe('execution control plane startup', () => {
  it('installs terminal consumers before scheduled producers start', async () => {
    const order = [];
    const wireEvents = mock(() => {
      order.push('wire');
      return { waitForIdle: mock(async () => undefined) };
    });
    const startDispatchers = mock(async () => {
      order.push('schedule');
    });

    const wiring = await startExecutionControlPlane({ wireEvents, startDispatchers });

    expect(order).toEqual(['wire', 'schedule']);
    expect(wiring.waitForIdle).toBeDefined();
  });

  it('propagates scheduled producer startup failure', async () => {
    await expect(startExecutionControlPlane({
      wireEvents: () => ({}),
      startDispatchers: async () => { throw new Error('schedule failed'); },
    })).rejects.toThrow('schedule failed');
  });
});

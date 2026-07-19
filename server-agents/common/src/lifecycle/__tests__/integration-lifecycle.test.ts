import { describe, expect, mock, test } from 'bun:test';
import { createIntegrationLifecycle } from '../integration-lifecycle.js';

describe('createIntegrationLifecycle', () => {
  test('is idempotent and cleans up a partial start', async () => {
    const start = mock(async () => {});
    const stop = mock(async () => {});
    const lifecycle = createIntegrationLifecycle({ start, stop });
    await lifecycle.start();
    await lifecycle.start();
    await lifecycle.stop();
    await lifecycle.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    const failedStop = mock(async () => {});
    const failed = createIntegrationLifecycle({
      start: async () => { throw new Error('boom'); },
      stop: failedStop,
    });
    await expect(failed.start()).rejects.toThrow('boom');
    expect(failedStop).toHaveBeenCalledTimes(1);
  });
});

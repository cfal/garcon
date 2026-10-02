import { expect, test } from 'bun:test';
import type { ExecutorBulkStatus } from '../../../common/executors.js';
import type { RemoteExecutorClient } from '../client/executor-client.js';
import { remoteFixture } from './integration-fixture.js';

function bulkReady(executor: RemoteExecutorClient): Promise<void> {
  if (executor.bulkStatus.availability === 'ready') return Promise.resolve();
  return new Promise(resolve => {
    const off = executor.onBulkChanged(status => {
      if (status.availability === 'ready') { off(); resolve(); }
    });
  });
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`bulk status distinguishes initial setup, recovery, and parent loss (${dialer} dials)`, async () => {
    let dialing = Promise.withResolvers<() => void>();
    const f = await remoteFixture(dialer, (controller, worker) => {
      const link = dialer === 'controller' ? controller : worker;
      const dial = link.dialBulk.bind(link);
      link.dialBulk = (...args) => { dialing.resolve(() => dial(...args)); };
    });
    const changes: ExecutorBulkStatus[] = [];
    f.executor.onBulkChanged(status => changes.push(status));
    try {
      const connect = await dialing.promise;
      expect(f.executor.bulkStatus).toEqual({ availability: 'connecting', lastError: null });
      expect(f.executor.availability).toBe('ready');
      connect();
      await bulkReady(f.executor);
      expect(changes).toEqual([{ availability: 'ready', lastError: null }]);

      dialing = Promise.withResolvers<() => void>();
      f.controller.bulk!.close(new Error('Synthetic bulk loss'));
      const reconnect = await dialing.promise;
      expect(f.executor.bulkStatus).toEqual({ availability: 'reconnecting',
        lastError: { code: 'EXECUTOR_BULK_UNAVAILABLE', message: 'Synthetic bulk loss' } });
      expect(f.executor.availability).toBe('ready');
      expect(changes).toHaveLength(2);
      reconnect();
      await bulkReady(f.executor);
      expect(f.executor.bulkStatus.lastError).toBeNull();
      expect(changes).toHaveLength(3);

      f.controller.disconnect();
      expect(f.executor.bulkStatus.availability).toBe('offline');
      expect(f.executor.availability).toBe('reconnecting');
      expect(changes).toHaveLength(4);
    } finally { await f.dispose(); }
    expect(f.executor.bulkStatus.availability).toBe('offline');
  });
}

import { expect, spyOn, test } from 'bun:test';
import { gitRpcFixture } from './git-rpc-fixture.js';
import { ExecutorRpc } from '../transport/rpc.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`Git and GH retain dispatch deadlines at RPC and reconnect acquisition (${dialer} dials)`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    const localGh = await fixture.local.getGhService();
    const info = await fixture.local.getInfo();
    const status = spyOn(localGh, 'getStatus').mockResolvedValue({
      executorId: info.executorId, instanceId: info.instanceId,
      available: false, authenticated: false, reason: 'gh_missing',
    });
    try {
      const git = await fixture.executor.getGitService();
      const gh = await fixture.executor.getGhService();
      const input = { projectPath: fixture.projectPath };
      const options = { timeoutMs: 2_000, dispatchDeadline: performance.now() + 1_000 };
      await git.getQuickSummary(input, options);
      await git.getBranches(input, options);
      await gh.getStatus(options);
      for (const method of ['git.getQuickSummary', 'git.getBranches', 'gh.getStatus']) {
        const call = calls.mock.calls.find(([, name]) => name === method);
        expect(call?.[3]?.dispatchDeadline).toBe(options.dispatchDeadline);
        expect(call?.[3]?.timeoutMs).toBeGreaterThan(0);
        expect(call?.[3]?.timeoutMs).toBeLessThanOrEqual(options.timeoutMs);
      }

      const reconnecting = Promise.withResolvers<void>();
      const off = fixture.executor.onAvailabilityChanged(value => {
        if (value === 'reconnecting') { off(); reconnecting.resolve(); }
      });
      await fixture.worker.dispose();
      await reconnecting.promise;
      const started = performance.now();
      const heldOptions = { timeoutMs: 2_000, dispatchDeadline: started + 50 };
      const failures = await Promise.all([
        git.getQuickSummary(input, heldOptions).catch(error => error),
        git.getBranches(input, heldOptions).catch(error => error),
        gh.getStatus(heldOptions).catch(error => error),
      ]);
      for (const error of failures) expect(error).toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      expect(performance.now() - started).toBeLessThan(1_000);

      const controller = new AbortController();
      const cancelled = git.getBranches(input, { signal: controller.signal, timeoutMs: 2_000 }).catch(error => error);
      controller.abort();
      expect(await cancelled).toMatchObject({ outcome: 'not-dispatched', message: 'The request was cancelled while the executor reconnected.' });
    } finally {
      status.mockRestore();
      calls.mockRestore();
      await fixture.dispose();
    }
  });
}

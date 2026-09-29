import { expect, test } from 'bun:test';
import type { ExecutorAvailability } from '@garcon/server-agent-interface';
import type { RemoteExecutorClient } from '../client/executor-client.js';
import { remoteFixture } from './integration-fixture.js';

function nextAvailability(executor: RemoteExecutorClient, expected: ExecutorAvailability): Promise<void> {
  return new Promise((resolve) => {
    const off = executor.onAvailabilityChanged((value) => { if (value === expected) { off(); resolve(); } });
  });
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`calls made while the executor reconnects complete on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const projects = await fixture.executor.getProjectService();
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const inspected = projects.inspect({ projectPath: '/test-project' });
      const running = integration.execution.runningSessions();
      const queried = integration.singleQuery!.run({
        prompt: 'Synthetic query', model: 'test-model', thinkingMode: 'medium',
        settings: integration.settings.defaults(), endpoint: null, signal: new AbortController().signal,
      });

      expect(await running).toEqual([]);
      expect(await queried).toBe('query result');
      await expect(inspected).resolves.toBeDefined();
      expect(fixture.executor.availability).toBe('ready');
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`held calls stop at their signal, their deadline, and the reconnect grace (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { client: { reconnectGraceMs: 500 } });
    try {
      const projects = await fixture.executor.getProjectService();
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      // Without its worker link, neither dial direction can reconnect.
      await fixture.worker.dispose();
      await reconnecting;
      const aborted = new AbortController();
      const cancelled = projects.inspect({ projectPath: '/test-project' }, { signal: aborted.signal }).catch((error: unknown) => error);
      const expired = projects.inspect({ projectPath: '/test-project' }, { timeoutMs: 50 }).catch((error: unknown) => error);
      const abandoned = projects.inspect({ projectPath: '/test-project' }).catch((error: unknown) => error);
      aborted.abort();

      expect(await cancelled).toMatchObject({ outcome: 'not-dispatched', message: 'The request was cancelled while the executor reconnected.' });
      expect(await expired).toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      expect(await abandoned).toMatchObject({ outcome: 'not-dispatched', message: 'Executor is offline' });
      expect(fixture.executor.availability).toBe('offline');
      await expect(fixture.executor.getProjectService()).rejects.toMatchObject({ outcome: 'not-dispatched' });
    } finally { await fixture.dispose(); }
  });
}
